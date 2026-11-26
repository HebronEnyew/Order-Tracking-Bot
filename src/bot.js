
import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { prisma } from "./prisma.js";

const token = process.env.BOT_TOKEN;
const adminGroupId = Number(process.env.ADMIN_GROUP_ID);

if (!token) {
  throw new Error("BOT_TOKEN is not defined.");
}

if (!Number.isSafeInteger(adminGroupId)) {
  throw new Error("ADMIN_GROUP_ID is missing or invalid.");
}

export const bot = new Bot(token);

// Customer registration and permanent topic creation
async function getOrCreateCustomer(from) {
  const displayName =
    [from.first_name, from.last_name]
      .filter(Boolean)
      .join(" ") || "Telegram Customer";

  let customer = await prisma.customer.upsert({
    where: {
      telegramId: BigInt(from.id),
    },
    update: {
      username: from.username ?? null,
      displayName,
    },
    create: {
      telegramId: BigInt(from.id),
      username: from.username ?? null,
      displayName,
    },
  });

  // Lock the customer row before checking or creating their topic
  customer = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT "forumTopicId"
      FROM "Customer"
      WHERE "id" = ${customer.id}
      FOR UPDATE
    `;

    const existingTopicId = rows[0]?.forumTopicId;

    // Another request may already have created the topic
    if (existingTopicId !== null && existingTopicId !== undefined) {
      return tx.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
    }

    // No topic exists, so create one
    const topicName =
      `Customer: ${displayName.slice(0, 85)} (${from.id})`;

    const topic = await bot.api.createForumTopic(
      adminGroupId,
      topicName
    );

    // Save the new topic ID
    return tx.customer.update({
      where: { id: customer.id },
      data: {
        forumTopicId: topic.message_thread_id,
      },
    });
  }, {
    maxWait: 5000,
    timeout: 20000,
  });

  return customer;
}

// Create or reuse the customer's currently collecting batch.
// Locking the customer row prevents two simultaneous messages from
// creating two active batches for the same customer.
async function getOrCreateCollectingBatch(customerId) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Customer"
      WHERE "id" = ${customerId}
      FOR UPDATE
    `;

    const existingBatch = await tx.orderBatch.findFirst({
      where: {
        customerId,
        status: {
          in: ["COLLECTING", "FAILED"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingBatch) {
      if (existingBatch.status === "FAILED") {
        return tx.orderBatch.update({
          where: {
            id: existingBatch.id,
          },
          data: {
            status: "COLLECTING",
          },
        });
      }

      return existingBatch;
    }

    return tx.orderBatch.create({
      data: {
        customerId,
        status: "COLLECTING",
      },
    });
  }, {
    maxWait: 5000,
    timeout: 20000,
  });
}

// Logging middleware
bot.use(async (ctx, next) => {
  const username =
    ctx.from?.username || ctx.from?.first_name || "Unknown User";

  console.log(
    `[Telegram Update] From @${username} in [${ctx.chat?.type} ID: ${ctx.chat?.id}]: ${ctx.message?.text ?? "Non-text message"}`
  );

  await next();
});

// Start command
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") {
    await ctx.reply(
      `Admin group detected. Chat ID: ${ctx.chat.id}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    const customer = await getOrCreateCustomer(ctx.from);

    await ctx.reply(
      `Welcome, ${customer.displayName}! 🛍️\n\n` +
      "Welcome to Valerie Collection!\n\n" +
      "Send us your SHEIN product links or screenshots. You can send multiple items, then tap Done, submit when you are finished."
    );
  } catch (error) {
    console.error("Customer registration failed:", error);

    await ctx.reply(
      "Sorry, something went wrong while setting up your account. Please try again later."
    );
  }
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Available commands:\n" +
    "/start - Register and get started\n" +
    "/help - Show available commands\n\n" +
    "Send multiple product links or screenshots, then tap Done, submit when you are finished."
  );
});

// Admin requests missing product options from a customer.
// Usage: reply to the product in the admin topic with /request size color quantity
bot.command("request", async (ctx) => {
  if (ctx.chat.id !== adminGroupId) return;

  try {
    const member = await bot.api.getChatMember(adminGroupId, ctx.from.id);

    if (!["creator", "administrator"].includes(member.status)) {
      await ctx.reply("You are not authorized to request product details.");
      return;
    }

    const repliedMessage = ctx.message.reply_to_message;

    if (!repliedMessage) {
      await ctx.reply(
        "Reply directly to the product message using:\n/request size color quantity\n\nYou can request any option names, for example: size color material length."
      );
      return;
    }

    const requestedOptions = ctx.match
      .trim()
      .split(/\s+/)
      .map((option) => option.trim().toLowerCase())
      .filter(Boolean);

    if (requestedOptions.length === 0) {
      await ctx.reply(
        "Please specify the options you need.\nExample: /request size color quantity"
      );
      return;
    }

    if (
      requestedOptions.some(
        (option) => !/^[a-z][a-z0-9_-]{0,29}$/.test(option)
      ) ||
      new Set(requestedOptions).size !== requestedOptions.length
    ) {
      await ctx.reply(
        "Option names must be simple words without spaces, and must not be repeated. Example: /request size color material"
      );
      return;
    }

    const order = await prisma.order.findUnique({
      where: { adminMessageId: repliedMessage.message_id },
      include: { customer: true, items: true },
    });

    if (!order || order.items.length !== 1) {
      await ctx.reply("I couldn't find one product linked to that message.");
      return;
    }

    if (order.status !== "AWAITING_PRICE") {
      await ctx.reply(
        `You can request options only before quoting. Current status: ${order.status}.`
      );
      return;
    }

    if (order.optionsRequestMessageId) {
      await ctx.reply(
        "This product already has an unanswered options request. Wait for the customer to reply first."
      );
      return;
    }

    if (order.sourceMessageId === null) {
      throw new Error("The original customer message ID is missing.");
    }

    const customerChatId = Number(order.customer.telegramId);

    if (!Number.isSafeInteger(customerChatId)) {
      throw new Error("Customer Telegram ID is invalid.");
    }

    const optionLabels = requestedOptions
      .map((option) => option.charAt(0).toUpperCase() + option.slice(1))
      .join(", ");

    const requestMessage = await bot.api.sendMessage(
      customerChatId,
      `Before we prepare the price for this product, please provide:\n\n${requestedOptions
        .map((option) => `${option.charAt(0).toUpperCase() + option.slice(1)}:`)
        .join("\n")}\n\nPlease reply to this message and use the labels above. For example:\n${requestedOptions
        .map((option) => `${option.charAt(0).toUpperCase() + option.slice(1)}: your answer`)
        .join("\n")}`,
      {
        reply_parameters: {
          message_id: order.sourceMessageId,
        },
      }
    );

    await prisma.$transaction([
      prisma.orderItem.update({
        where: { id: order.items[0].id },
        data: { requestedOptions },
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { optionsRequestMessageId: requestMessage.message_id },
      }),
    ]);

    await ctx.reply(
      `Options requested successfully. ✅\n\nProduct: ${order.items[0].productName || order.items[0].itemDescription || `Order #${order.orderNumber}`}\nRequested: ${optionLabels}`
    );
  } catch (error) {
    console.error("Product options request failed:", error);

    await ctx.reply(
      "Something went wrong while requesting the product options. Check the server logs."
    );
  }
});

// Admin quote command
bot.command("quote", async (ctx) => {
  // Only handle this command inside the configured admin group.
  if (ctx.chat.id !== adminGroupId) return;

  try {
    const member = await bot.api.getChatMember(adminGroupId, ctx.from.id);

    if (!["creator", "administrator"].includes(member.status)) {
      await ctx.reply("You are not authorized to issue quotes.");
      return;
    }

    const repliedMessage = ctx.message.reply_to_message;

    if (!repliedMessage) {
      await ctx.reply(
        "Reply directly to an order message using:\n/quote <supplierPrice> <fixedProfit>"
      );
      return;
    }

    const args = ctx.match.trim().split(/\s+/);

    if (args.length !== 2) {
      await ctx.reply("Invalid format.\n\nExample: /quote 800 200");
      return;
    }

    const supplierPrice = Number(args[0]);
    const fixedProfit = Number(args[1]);

    if (
      !Number.isFinite(supplierPrice) ||
      !Number.isFinite(fixedProfit) ||
      supplierPrice <= 0 ||
      fixedProfit < 0
    ) {
      await ctx.reply(
        "Prices must be valid numbers. Supplier price must be greater than zero, and profit cannot be negative."
      );
      return;
    }

    const customerPrice = supplierPrice + fixedProfit;

    const order = await prisma.order.findUnique({
      where: { adminMessageId: repliedMessage.message_id },
      include: { customer: true, items: true },
    });

    if (!order) {
      await ctx.reply("I couldn't find an order linked to that message.");
      return;
    }

    if (order.optionsRequestMessageId) {
      await ctx.reply(
        "You still have an unanswered options request for this product. Wait for the customer to provide the details before quoting."
      );
      return;
    }

    if (
      order.status !== "AWAITING_PRICE" &&
      order.status !== "PRICE_SENT"
    ) {
      await ctx.reply(
        `This order cannot be quoted because its current status is ${order.status}.`
      );
      return;
    }

    if (order.items.length !== 1) {
      throw new Error(
        `Expected one item for order #${order.orderNumber}, found ${order.items.length}.`
      );
    }

    const item = order.items[0];

    await prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { supplierPrice, customerPrice },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PRICE_SENT",
          totalSupplierCost: supplierPrice,
          totalCustomerPrice: customerPrice,
          netProfit: fixedProfit,
        },
      });
    });

    const customerChatId = Number(order.customer.telegramId);

    if (!Number.isSafeInteger(customerChatId)) {
      throw new Error("Customer Telegram ID is invalid.");
    }

    const productLabel =
      item.productName ||
      item.itemDescription ||
      "the product you submitted";

    const keyboard = new InlineKeyboard()
      .text("✅ Accept price", `accept:${order.id}`)
      .text("❌ Decline quote", `decline:${order.id}`);

    try {
      await bot.api.sendMessage(
        customerChatId,
        `Your product has been priced! 🛍️\n\n` +
          `Product: ${productLabel}\n` +
          `Your total price: ${customerPrice.toLocaleString()}\n\n` +
          "Would you like to proceed with this product?",
        {
          ...(order.sourceMessageId
            ? { reply_parameters: { message_id: order.sourceMessageId } }
            : {}),
          reply_markup: keyboard,
        }
      );
    } catch (notificationError) {
      console.error(
        "Quote saved, but customer notification failed:",
        notificationError
      );

      await ctx.reply(
        `Quote saved for order #${order.orderNumber}, but I couldn't notify the customer. They may need to start the bot or unblock it.`
      );
      return;
    }

    await ctx.reply(
      `Quote sent successfully! ✅\n\n` +
        `Order: #${order.orderNumber}\n` +
        `Supplier price: ${supplierPrice.toLocaleString()}\n` +
        `Fixed profit: ${fixedProfit.toLocaleString()}\n` +
        `Customer price: ${customerPrice.toLocaleString()}`
    );
  } catch (error) {
    console.error("Quote processing failed:", error);

    await ctx.reply(
      "Something went wrong while processing this quote. Check the server logs."
    );
  }
});

// Customer confirms that they have finished sending products.
// Submit all products in a customer's batch.
// Each product remains an independent Order and can be quoted separately.
bot.callbackQuery(/^submit_batch:/, async (ctx) => {
  const batchId = ctx.callbackQuery.data.split(":")[1];

  try {
    const batch = await prisma.orderBatch.findUnique({
      where: {
        id: batchId,
      },
      include: {
        customer: true,
        orders: {
          include: {
            items: true,
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!batch) {
      await ctx.answerCallbackQuery({
        text: "This submission could not be found.",
        show_alert: true,
      });
      return;
    }

    // Only the customer who created this batch can submit it.
    if (batch.customer.telegramId !== BigInt(ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "This submission does not belong to you.",
        show_alert: true,
      });
      return;
    }

    if (batch.status === "SUBMITTED") {
      await ctx.answerCallbackQuery({
        text: "This batch has already been submitted.",
      });
      return;
    }

    if (batch.status === "SUBMITTING") {
      await ctx.answerCallbackQuery({
        text: "Your products are already being submitted. Please wait.",
      });
      return;
    }

    if (!["COLLECTING", "FAILED"].includes(batch.status)) {
      await ctx.answerCallbackQuery({
        text: "This batch can no longer be submitted.",
        show_alert: true,
      });
      return;
    }

    if (batch.orders.length === 0) {
      await ctx.answerCallbackQuery({
        text: "There are no products to submit yet.",
        show_alert: true,
      });
      return;
    }

    if (!batch.customer.forumTopicId) {
      throw new Error("Customer forum topic ID is missing.");
    }

    // Claim the batch so simultaneous button taps cannot submit it twice.
    // Failed attempts can be retried; already-copied messages are skipped
    // using each Order's adminMessageId.
    const claim = await prisma.orderBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
      },
      data: {
        status: "SUBMITTING",
      },
    });

    if (claim.count === 0) {
      await ctx.answerCallbackQuery({
        text: "Your products are already being submitted. Please wait.",
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: "Submitting your products...",
    });

    const customerChatId = Number(batch.customer.telegramId);

    if (!Number.isSafeInteger(customerChatId)) {
      throw new Error("Customer Telegram ID is invalid.");
    }

    // Add one admin summary message. Save its ID so a retry does not
    // create duplicate summaries.
    if (!batch.adminSummaryMessageId) {
      const username = batch.customer.username
        ? `@${batch.customer.username}`
        : "Not available";

      const summary =
        `🛍️ NEW PRODUCT SUBMISSION — BATCH #${batch.batchNumber}\n\n` +
        `Customer: ${batch.customer.displayName}\n` +
        `Telegram: ${username}\n` +
        `Phone: ${batch.customer.phoneNumber ?? "Not shared"}\n` +
        `Products: ${batch.orders.length}\n\n` +
        "Each product below is a separate order and should be quoted individually.";

      const summaryMessage = await bot.api.sendMessage(
        adminGroupId,
        summary,
        {
          message_thread_id: batch.customer.forumTopicId,
        }
      );

      await prisma.orderBatch.update({
        where: {
          id: batch.id,
        },
        data: {
          adminSummaryMessageId: summaryMessage.message_id,
        },
      });
    }

// Copy each original customer message into the customer's topic.
// Each copied message is linked to its own Order for /quote.
for (const order of batch.orders) {
  if (order.adminMessageId) continue;

  if (order.sourceMessageId === null) {
    throw new Error(`Order ${order.id} has no source Telegram message ID.`);
  }

  const copiedMessage = await bot.api.copyMessage(
    adminGroupId,
    customerChatId,
    order.sourceMessageId,
    {
      message_thread_id: batch.customer.forumTopicId,
    }
  );

  await prisma.order.update({
    where: {
      id: order.id,
    },
    data: {
      adminMessageId: copiedMessage.message_id,
    },
  });
}

// Only make the orders quotable after every original message has
// been copied successfully to the admin topic.
await prisma.$transaction([
  prisma.order.updateMany({
    where: {
      batchId: batch.id,
      status: "AWAITING_DETAILS",
    },
    data: {
      status: "AWAITING_PRICE",
      intakeStep: null,
    },
  }),
  prisma.orderBatch.update({
    where: {
      id: batch.id,
    },
    data: {
      status: "SUBMITTED",
      submittedAt: new Date(),
    },
  }),
]);

const promptMessageId =
  batch.promptMessageId ?? ctx.callbackQuery.message?.message_id;

if (promptMessageId) {
  try {
    await bot.api.editMessageText(
      customerChatId,
      promptMessageId,
      `Your ${batch.orders.length} product${batch.orders.length === 1 ? "" : "s"} have been submitted successfully! 🎉\n\n` +
        "We'll review them and send you a price for each product separately."
    );
  } catch (editError) {
    console.error("Could not update the batch prompt:", editError);
  }
} else {
  await bot.api.sendMessage(
    customerChatId,
    `Your ${batch.orders.length} products have been submitted successfully! 🎉\n\n` +
      "We'll review them and send you a price for each product separately."
  );
}

console.log(
  `Batch #${batch.batchNumber} submitted with ${batch.orders.length} products.`
);
} catch (error) {
  console.error("Batch submission failed:", error);

  // Mark the attempt as failed so the same batch can be retried.
  // Any successfully copied messages are preserved and won't duplicate.
  try {
    const batchIdFromCallback = ctx.callbackQuery.data.split(":")[1];

    await prisma.orderBatch.updateMany({
      where: {
        id: batchIdFromCallback,
        status: "SUBMITTING",
      },
      data: {
        status: "FAILED",
      },
    });
  } catch (statusError) {
    console.error("Could not mark batch submission as failed:", statusError);
  }

  await ctx.reply(
    "I couldn't finish submitting your products. Please press 'Done, submit' again in a moment."
  );
}
});

// Handle customer quote decisions
bot.on("callback_query:data", async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery.data;

    console.log("Button clicked:", callbackData);

    // Split callback data into action and order ID
    const [action, orderId] = callbackData.split(":");

    if (!["accept", "decline"].includes(action) || !orderId) {
      await ctx.answerCallbackQuery({
        text: "Invalid button action.",
        show_alert: true,
      });
      return;
    }

    // Find the order and its customer
    const order = await prisma.order.findUnique({
      where: {
        id: orderId,
      },
      include: {
        customer: true,
      },
    });

    if (!order) {
      await ctx.answerCallbackQuery({
        text: "Order not found.",
        show_alert: true,
      });
      return;
    }

    // Verify that the person clicking owns this order
    if (order.customer.telegramId !== BigInt(ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "This order does not belong to you.",
        show_alert: true,
      });
      return;
    }

    // Make sure the order has actually been quoted
    if (order.status !== "PRICE_SENT") {
      await ctx.answerCallbackQuery({
        text: "This quote has already been processed or is no longer active.",
        show_alert: true,
      });
      return;
    }

    // Determine the new order status
    const newStatus =
      action === "accept"
        ? "CUSTOMER_ACCEPTED"
        : "CUSTOMER_DECLINED";

    // Update order only if it is still awaiting a customer decision
    const result = await prisma.order.updateMany({
      where: {
        id: order.id,
        status: "PRICE_SENT",
      },
      data: {
        status: newStatus,
      },
    });

    if (result.count === 0) {
      await ctx.answerCallbackQuery({
        text: "This quote has already been processed.",
        show_alert: true,
      });
      return;
    }

    // Acknowledge the button click
    await ctx.answerCallbackQuery({
      text:
        action === "accept"
          ? "You accepted the price!"
          : "You declined the quote.",
    });

    // Remove the buttons from the original quote message
    await ctx.editMessageReplyMarkup({
      reply_markup: undefined,
    });

    // Notify admin in the customer's existing topic
    const decisionText =
      action === "accept" ? "ACCEPTED" : "DECLINED";

    const adminNotification =
      `🔔 Customer decision received!\n\n` +
      `Order: #${order.orderNumber}\n` +
      `Customer: ${order.customer.displayName}\n` +
      `Decision: ${decisionText}\n` +
      `Quoted price: ${order.totalCustomerPrice.toLocaleString()}\n\n` +
      (
        action === "accept"
          ? "The customer agreed to proceed with this order."
          : "The customer declined this quote."
      );

    try {
      if (!order.customer.forumTopicId) {
        throw new Error("Customer forum topic ID is missing.");
      }

      await bot.api.sendMessage(
        adminGroupId,
        adminNotification,
        {
          message_thread_id: order.customer.forumTopicId,
        }
      );

      console.log(
        `Admin notified about order #${order.orderNumber}: ${decisionText}`
      );
    } catch (notificationError) {
      console.error(
        "Failed to notify admin about customer decision:",
        notificationError
      );
    }

    // Confirm the decision to the customer
    await ctx.reply(
      action === "accept"
        ? "Thank you! 🎉 We've recorded your acceptance. Our team will proceed with your order."
        : "No problem! Your quote has been declined. Thank you for considering Valerie Collection. ❤️"
    );
  } catch (error) {
    console.error("Quote decision processing failed:", error);

    await ctx.answerCallbackQuery({
      text: "Something went wrong. Please try again.",
      show_alert: true,
    });
  }
});

// Customer product collection
// Each incoming product message becomes one Order with one OrderItem.
// Multiple Orders are grouped by an OrderBatch until the customer submits.
const batchPromptTimers = new Map();

function scheduleBatchPrompt(customer, batchId, isAlbumPart = false) {
  const existingTimer = batchPromptTimers.get(batchId);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Telegram sends each photo in a media album as a separate update.
  // Debouncing gives the album updates time to arrive before showing
  // one updated submission prompt.
  const timer = setTimeout(async () => {
    batchPromptTimers.delete(batchId);

    try {
      const batch = await prisma.orderBatch.findUnique({
        where: {
          id: batchId,
        },
      });

      if (!batch || batch.status !== "COLLECTING") return;

      const pendingCount = await prisma.order.count({
        where: {
          batchId,
          status: "AWAITING_DETAILS",
        },
      });

      if (pendingCount === 0) return;

      const customerChatId = Number(customer.telegramId);

      if (!Number.isSafeInteger(customerChatId)) {
        throw new Error("Customer Telegram ID is invalid.");
      }

      const promptText =
        `I've received ${pendingCount} product${pendingCount === 1 ? "" : "s"}! 🛍️\n\n` +
        "You can send more product links or screenshots, or tap **Done, submit** when you've sent everything.\n\n" +
        "We'll submit the products together, and you can receive a separate price for each one.";

      const keyboard = new InlineKeyboard().text(
        "✅ Done, submit",
        `submit_batch:${batchId}`
      );

      // Edit the existing prompt instead of sending a new prompt
      // every time another product arrives.
      if (batch.promptMessageId) {
        try {
          await bot.api.editMessageText(
            customerChatId,
            batch.promptMessageId,
            promptText,
            {
              parse_mode: "Markdown",
              reply_markup: keyboard,
            }
          );
          return;
        } catch (error) {
          if (error.description?.includes("message is not modified")) {
            return;
          }

          console.error("Could not edit existing batch prompt:", error);
        }
      }

      const promptMessage = await bot.api.sendMessage(
        customerChatId,
        promptText,
        {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }
      );

      await prisma.orderBatch.update({
        where: {
          id: batchId,
        },
        data: {
          promptMessageId: promptMessage.message_id,
        },
      });

      if (isAlbumPart) {
        console.log(
          `Collected Telegram album updates for batch #${batch.batchNumber}.`
        );
      }
    } catch (error) {
      console.error("Failed to send batch submission prompt:", error);
    }
  }, 1000);

  batchPromptTimers.set(batchId, timer);
}

// Receive product links, screenshots, and other product messages.
bot.on(["message:text", "message:photo"], async (ctx, next) => {
  if (ctx.chat.type !== "private") {
    return next();
  }

  // Let commands such as /start and /help reach their handlers.
  if (ctx.message.text?.startsWith("/")) {
    return next();
  }

  try {
    const customer = await getOrCreateCustomer(ctx.from);

    if (!customer.forumTopicId) {
      throw new Error("Customer has no Telegram forum topic.");
    }

    // If the customer replied to an options request, save the answer
    // against that exact product instead of treating it as a new product.
    const repliedMessageId = ctx.message.reply_to_message?.message_id;

    if (repliedMessageId && ctx.message.text) {
      const pendingOrder = await prisma.order.findUnique({
        where: { optionsRequestMessageId: repliedMessageId },
        include: { customer: true, items: true },
      });

      if (pendingOrder) {
        if (pendingOrder.customer.telegramId !== BigInt(ctx.from.id)) {
          await ctx.reply("This product options request does not belong to you.");
          return;
        }

        if (pendingOrder.items.length !== 1) {
          throw new Error("Expected one item for the options request.");
        }

        const item = pendingOrder.items[0];
        const requestedOptions = item.requestedOptions ?? [];
        const answers = {};

        for (const line of ctx.message.text.split(/\r?\n/)) {
          const separatorIndex = line.indexOf(":");

          if (separatorIndex === -1) continue;

          const key = line.slice(0, separatorIndex).trim().toLowerCase();
          const value = line.slice(separatorIndex + 1).trim();

          if (key && value) answers[key] = value;
        }

        const missingOptions = requestedOptions.filter(
          (option) => !answers[option]
        );

        if (missingOptions.length > 0) {
          await ctx.reply(
            `I still need these details for that product: ${missingOptions.join(", ")}.\n\nPlease reply again using the requested labels.`
          );
          return;
        }

        const itemUpdate = {
          requestedOptions: [],
        };

        const extraOptions = { ...(item.options ?? {}) };

        for (const option of requestedOptions) {
          const value = answers[option];

          if (option === "size" || option === "color") {
            itemUpdate[option] = value;
          } else if (option === "quantity") {
            const quantity = Number(value);

            if (!Number.isInteger(quantity) || quantity < 1) {
              await ctx.reply(
                "Quantity must be a whole number greater than zero. Please reply again."
              );
              return;
            }

            itemUpdate.quantity = quantity;
          } else {
            extraOptions[option] = value;
          }
        }

        if (Object.keys(extraOptions).length > 0) {
          itemUpdate.options = extraOptions;
        }

        await prisma.$transaction([
          prisma.orderItem.update({
            where: { id: item.id },
            data: itemUpdate,
          }),
          prisma.order.update({
            where: { id: pendingOrder.id },
            data: { optionsRequestMessageId: null },
          }),
        ]);

        await ctx.reply(
          "Thank you! ❤️ I've saved those options for your product. Our team can now prepare your price."
        );
        return;
      }
    }

// Reuse the customer's active batch or create a new one.
const batch = await getOrCreateCollectingBatch(customer.id);

const messageText =
  ctx.message.text ?? ctx.message.caption ?? "";

// Extract a SHEIN URL, if the customer included one.
const urlMatch = messageText.match(/https?:\/\/\S+/i);

const sheinUrl = urlMatch
  ? urlMatch[0].replace(/[.,!?;:)]+$/, "")
  : null;

const isPhoto = Boolean(ctx.message.photo?.length);

const itemDescription =
  messageText.trim() ||
  (isPhoto
    ? "Product screenshot submitted"
    : "Product details submitted");

try {
  await prisma.order.create({
    data: {
      customerId: customer.id,
      batchId: batch.id,
      status: "AWAITING_DETAILS",
      sourceMessageId: ctx.message.message_id,
      items: {
        create: {
          sheinUrl,
          itemDescription,
          quantity: 1,
        },
      },
    },
  });
} catch (error) {
  // Prevent duplicate processing of the same Telegram message.
  if (error.code === "P2002") {
    await ctx.reply(
      "We've already received this product. 🛍️"
    );
    return;
  }

  throw error;
}

// A short pause groups album updates and rapid individual messages.
scheduleBatchPrompt(
  customer,
  batch.id,
  Boolean(ctx.message.media_group_id)
);
} catch (error) {
  console.error("Product submission failed:", error);

  await ctx.reply(
    "Something went wrong while receiving your product. Please try again later."
  );
}
});

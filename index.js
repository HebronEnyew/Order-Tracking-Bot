import express from "express";
import "dotenv/config";
import { bot } from "./src/bot.js";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Shein Reseller Bot Server is Running!");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

bot.start();
console.log("Bot is running via long polling...");
import { prisma } from "./src/prisma.js";

try {
    const result = await prisma.$queryRaw`SELECT 1 AS connected`;
    console.log("Database connection successful:", result);
} catch (error) {
    console.error("Error connecting to the database:", error);  
} finally {
    await prisma.$disconnect();
}
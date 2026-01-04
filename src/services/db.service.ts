import { PrismaClient } from '@prisma/client';

// Singleton Prisma client
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

/**
 * Connect to the database
 */
export async function connectDatabase(): Promise<void> {
    await prisma.$connect();
    console.error('Database connected');
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
    await prisma.$disconnect();
    console.error('Database disconnected');
}

/**
 * Cleanup expired sessions and tokens
 */
export async function cleanupExpiredData(): Promise<void> {
    const now = new Date();

    // Delete expired sessions
    const deletedSessions = await prisma.session.deleteMany({
        where: {
            expiresAt: { lt: now }
        }
    });

    // Delete expired OAuth tokens
    const deletedTokens = await prisma.oauthToken.deleteMany({
        where: {
            accessTokenExpiresAt: { lt: now }
        }
    });

    // Delete expired authorization codes (older than 10 minutes)
    const codeExpiry = new Date(now.getTime() - 10 * 60 * 1000);
    const deletedCodes = await prisma.oauthAuthorizationCode.deleteMany({
        where: {
            createdAt: { lt: codeExpiry }
        }
    });

    if (deletedSessions.count > 0 || deletedTokens.count > 0 || deletedCodes.count > 0) {
        console.error(`Cleanup: ${deletedSessions.count} sessions, ${deletedTokens.count} tokens, ${deletedCodes.count} auth codes`);
    }
}

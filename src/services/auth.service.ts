import bcrypt from 'bcrypt';
import { prisma } from './db.service.js';
import { User, Session } from '@prisma/client';

const SALT_ROUNDS = 12;
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface AuthUser {
    id: string;
    email: string;
    name: string | null;
}

/**
 * Register a new user
 */
export async function registerUser(
    email: string,
    password: string,
    name?: string
): Promise<AuthUser> {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
        where: { email: email.toLowerCase() }
    });

    if (existingUser) {
        throw new Error('User with this email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const user = await prisma.user.create({
        data: {
            email: email.toLowerCase(),
            passwordHash,
            name: name || null
        }
    });

    return {
        id: user.id,
        email: user.email,
        name: user.name
    };
}

/**
 * Authenticate a user with email and password
 */
export async function authenticateUser(
    email: string,
    password: string
): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() }
    });

    if (!user) {
        return null;
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
        return null;
    }

    return {
        id: user.id,
        email: user.email,
        name: user.name
    };
}

/**
 * Create a new session for a user
 */
export async function createSession(userId: string): Promise<Session> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

    const session = await prisma.session.create({
        data: {
            userId,
            expiresAt
        }
    });

    return session;
}

/**
 * Validate a session and update last access time
 */
export async function validateSession(sessionId: string): Promise<AuthUser | null> {
    const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { user: true }
    });

    if (!session) {
        return null;
    }

    // Check if expired
    if (session.expiresAt < new Date()) {
        // Delete expired session
        await prisma.session.delete({ where: { id: sessionId } });
        return null;
    }

    // Update last access
    await prisma.session.update({
        where: { id: sessionId },
        data: { lastAccess: new Date() }
    });

    return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name
    };
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(sessionId: string): Promise<void> {
    await prisma.session.delete({
        where: { id: sessionId }
    }).catch(() => {
        // Ignore if session doesn't exist
    });
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId }
    });

    if (!user) {
        return null;
    }

    return {
        id: user.id,
        email: user.email,
        name: user.name
    };
}

/**
 * Delete all sessions for a user
 */
export async function deleteAllUserSessions(userId: string): Promise<void> {
    await prisma.session.deleteMany({
        where: { userId }
    });
}

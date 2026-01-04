-- Database initialization script for Voice Call MCP Server
-- Note: Tables are created by Prisma migrations, not this script
-- This script only creates helper functions

-- Create cleanup function for expired data (will work once tables exist)
CREATE OR REPLACE FUNCTION cleanup_expired_data() RETURNS void AS $$
BEGIN
    -- Delete expired sessions (if table exists)
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'sessions') THEN
        DELETE FROM sessions WHERE expires_at < NOW();
    END IF;

    -- Delete expired OAuth tokens (if table exists)
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'oauth_tokens') THEN
        DELETE FROM oauth_tokens WHERE access_token_expires_at < NOW();
    END IF;

    -- Delete old authorization codes (if table exists)
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'oauth_authorization_codes') THEN
        DELETE FROM oauth_authorization_codes WHERE created_at < NOW() - INTERVAL '10 minutes';
    END IF;

    RAISE NOTICE 'Cleanup completed at %', NOW();
END;
$$ LANGUAGE plpgsql;

-- Note: Indexes are created by Prisma migrations

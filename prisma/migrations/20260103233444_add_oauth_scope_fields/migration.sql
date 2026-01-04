-- AlterTable
ALTER TABLE "oauth_authorization_codes" ADD COLUMN     "authorization_details" JSONB,
ADD COLUMN     "scope" TEXT;

-- AlterTable
ALTER TABLE "oauth_clients" ADD COLUMN     "description" TEXT,
ADD COLUMN     "logo_uri" TEXT,
ADD COLUMN     "scope" TEXT;

-- AlterTable
ALTER TABLE "oauth_tokens" ADD COLUMN     "authorization_details" JSONB,
ADD COLUMN     "scope" TEXT;

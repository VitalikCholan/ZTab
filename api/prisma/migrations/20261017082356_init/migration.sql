-- CreateEnum
CREATE TYPE "mode" AS ENUM ('group', 'individual');

-- CreateEnum
CREATE TYPE "blob_role" AS ENUM ('admin', 'group', 'participant');

-- CreateTable
CREATE TABLE "tabs" (
    "id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "participants_count" INTEGER NOT NULL,
    "ufvk" TEXT NOT NULL,
    "birthday" INTEGER NOT NULL,
    "network" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "last_known_state" TEXT NOT NULL DEFAULT 'open',
    "last_known_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_access_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "tabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tab_addresses" (
    "tab_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "address" TEXT NOT NULL,

    CONSTRAINT "tab_addresses_pkey" PRIMARY KEY ("tab_id","index")
);

-- CreateTable
CREATE TABLE "tab_blobs" (
    "id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "role" "blob_role" NOT NULL,
    "index" INTEGER,
    "ciphertext" BYTEA NOT NULL,

    CONSTRAINT "tab_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tab_tokens" (
    "id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "role" "blob_role" NOT NULL,
    "index" INTEGER,
    "token_hash" BYTEA NOT NULL,

    CONSTRAINT "tab_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tab_blobs_tab_id_role_index_key" ON "tab_blobs"("tab_id", "role", "index");

-- CreateIndex
CREATE UNIQUE INDEX "tab_tokens_token_hash_key" ON "tab_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "tab_addresses" ADD CONSTRAINT "tab_addresses_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tab_blobs" ADD CONSTRAINT "tab_blobs_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tab_tokens" ADD CONSTRAINT "tab_tokens_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

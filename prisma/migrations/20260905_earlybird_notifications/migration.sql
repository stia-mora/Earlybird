CREATE TABLE "EarlyBirdPoll" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detectedCount" INTEGER NOT NULL DEFAULT 0,
    "postIds" JSONB,
    "error" TEXT,
    "polledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EarlyBirdPoll_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EarlyBirdPoll_sourceId_polledAt_idx" ON "EarlyBirdPoll"("sourceId", "polledAt");
CREATE INDEX "EarlyBirdPoll_outcome_polledAt_idx" ON "EarlyBirdPoll"("outcome", "polledAt");
ALTER TABLE "EarlyBirdPoll" ADD CONSTRAINT "EarlyBirdPoll_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "EarlyBirdSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyBirdNotification" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EarlyBirdNotification_dedupeKey_key" ON "EarlyBirdNotification"("dedupeKey");
CREATE INDEX "EarlyBirdNotification_kind_createdAt_idx" ON "EarlyBirdNotification"("kind", "createdAt");
CREATE INDEX "EarlyBirdNotification_status_updatedAt_idx" ON "EarlyBirdNotification"("status", "updatedAt");

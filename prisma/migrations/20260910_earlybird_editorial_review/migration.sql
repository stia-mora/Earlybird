-- Independent EarlyBird editorial review, revision audit, and draft replacement history.
ALTER TABLE "EarlyBirdDraft" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "EarlyBirdDraft" ADD COLUMN "deleteError" TEXT;

CREATE TABLE "EarlyBirdEditorialReview" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "decision" TEXT NOT NULL,
    "contentType" TEXT,
    "qualityScore" INTEGER,
    "issues" JSONB,
    "rewriteInstructions" TEXT,
    "visualPlan" JSONB,
    "relatedJobIds" JSONB,
    "inputHash" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EarlyBirdEditorialReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EarlyBirdEditorialReview_jobId_createdAt_idx" ON "EarlyBirdEditorialReview"("jobId", "createdAt");
CREATE INDEX "EarlyBirdEditorialReview_decision_createdAt_idx" ON "EarlyBirdEditorialReview"("decision", "createdAt");
ALTER TABLE "EarlyBirdEditorialReview" ADD CONSTRAINT "EarlyBirdEditorialReview_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "EarlyBirdArticleJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyBirdDraftReplacement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "oldMediaId" TEXT,
    "newMediaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdDraftReplacement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EarlyBirdDraftReplacement_jobId_createdAt_idx" ON "EarlyBirdDraftReplacement"("jobId", "createdAt");
CREATE INDEX "EarlyBirdDraftReplacement_newMediaId_idx" ON "EarlyBirdDraftReplacement"("newMediaId");
CREATE INDEX "EarlyBirdDraftReplacement_status_updatedAt_idx" ON "EarlyBirdDraftReplacement"("status", "updatedAt");
ALTER TABLE "EarlyBirdDraftReplacement" ADD CONSTRAINT "EarlyBirdDraftReplacement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "EarlyBirdArticleJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

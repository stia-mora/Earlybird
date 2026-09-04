-- EarlyBird X -> WeChat draft pipeline
CREATE TABLE "EarlyBirdSource" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "baselineComplete" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenCreatedAt" TIMESTAMP(3),
    "lastSeenPostId" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyBirdSource_handle_key" ON "EarlyBirdSource"("handle");

CREATE TABLE "EarlyBirdPost" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "rootPostId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "authorUsername" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3),
    "rawData" JSONB NOT NULL,
    "threadData" JSONB,
    "mediaData" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EarlyBirdPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyBirdPost_sourceId_postId_key" ON "EarlyBirdPost"("sourceId", "postId");
CREATE INDEX "EarlyBirdPost_rootPostId_idx" ON "EarlyBirdPost"("rootPostId");
CREATE INDEX "EarlyBirdPost_createdAt_idx" ON "EarlyBirdPost"("createdAt");
ALTER TABLE "EarlyBirdPost" ADD CONSTRAINT "EarlyBirdPost_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "EarlyBirdSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyBirdAsset" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "localPath" TEXT,
    "publicUrl" TEXT,
    "sha256" TEXT,
    "mimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "wechatMediaId" TEXT,
    "wechatUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyBirdAsset_postId_sourceUrl_key" ON "EarlyBirdAsset"("postId", "sourceUrl");
CREATE INDEX "EarlyBirdAsset_sha256_idx" ON "EarlyBirdAsset"("sha256");
ALTER TABLE "EarlyBirdAsset" ADD CONSTRAINT "EarlyBirdAsset_postId_fkey" FOREIGN KEY ("postId") REFERENCES "EarlyBirdPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyBirdArticleJob" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "markdown" TEXT,
    "html" TEXT,
    "humanizerScore" INTEGER,
    "metadata" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdArticleJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyBirdArticleJob_postId_key" ON "EarlyBirdArticleJob"("postId");
CREATE INDEX "EarlyBirdArticleJob_status_updatedAt_idx" ON "EarlyBirdArticleJob"("status", "updatedAt");
ALTER TABLE "EarlyBirdArticleJob" ADD CONSTRAINT "EarlyBirdArticleJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "EarlyBirdSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EarlyBirdArticleJob" ADD CONSTRAINT "EarlyBirdArticleJob_postId_fkey" FOREIGN KEY ("postId") REFERENCES "EarlyBirdPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EarlyBirdDraft" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "requestSummary" JSONB,
    "verification" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EarlyBirdDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EarlyBirdDraft_jobId_key" ON "EarlyBirdDraft"("jobId");
CREATE UNIQUE INDEX "EarlyBirdDraft_mediaId_key" ON "EarlyBirdDraft"("mediaId");
ALTER TABLE "EarlyBirdDraft" ADD CONSTRAINT "EarlyBirdDraft_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "EarlyBirdArticleJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

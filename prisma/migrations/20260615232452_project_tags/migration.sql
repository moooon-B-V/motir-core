-- CreateTable
CREATE TABLE "project_tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tag_assignment" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_tag_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_tag_slug_key" ON "project_tag"("slug");

-- CreateIndex
CREATE INDEX "project_tag_assignment_tag_id_idx" ON "project_tag_assignment"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_tag_assignment_project_id_tag_id_key" ON "project_tag_assignment"("project_id", "tag_id");

-- AddForeignKey
ALTER TABLE "project_tag_assignment" ADD CONSTRAINT "project_tag_assignment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tag_assignment" ADD CONSTRAINT "project_tag_assignment_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "project_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

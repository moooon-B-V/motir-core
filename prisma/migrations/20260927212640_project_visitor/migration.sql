-- CreateTable
CREATE TABLE "project_visitor" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "first_visit_at" TIMESTAMPTZ(3) NOT NULL,
    "last_visit_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_visitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_visitor_project_id_last_visit_at_idx" ON "project_visitor"("project_id", "last_visit_at");

-- CreateIndex
CREATE INDEX "project_visitor_user_id_idx" ON "project_visitor"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_visitor_project_id_user_id_key" ON "project_visitor"("project_id", "user_id");

-- AddForeignKey
ALTER TABLE "project_visitor" ADD CONSTRAINT "project_visitor_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_visitor" ADD CONSTRAINT "project_visitor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

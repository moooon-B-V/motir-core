-- CreateTable
CREATE TABLE "canvas_node_position" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvas_node_position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canvas_node_position_user_id_project_id_idx" ON "canvas_node_position"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "canvas_node_position_project_id_idx" ON "canvas_node_position"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "canvas_node_position_user_id_project_id_node_key_key" ON "canvas_node_position"("user_id", "project_id", "node_key");

-- AddForeignKey
ALTER TABLE "canvas_node_position" ADD CONSTRAINT "canvas_node_position_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_node_position" ADD CONSTRAINT "canvas_node_position_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

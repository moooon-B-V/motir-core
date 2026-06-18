-- CreateTable
CREATE TABLE "user_appearance_preference" (
    "user_id" TEXT NOT NULL,
    "pattern" TEXT,
    "style_id" TEXT,
    "palette_id" TEXT,
    "type_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "user_appearance_preference_user_id_key" ON "user_appearance_preference"("user_id");

-- AddForeignKey
ALTER TABLE "user_appearance_preference" ADD CONSTRAINT "user_appearance_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

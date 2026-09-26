-- MOTIR-6471 — the monochrome palette (`graphite`) becomes `motir`, and the warm
-- palette that was `motir` becomes `amethyst`. A stored id therefore names the
-- OTHER palette after the rename, so every saved choice is carried across.
--
-- ONE statement with a CASE, never two sequential UPDATEs: `graphite`→`motir`
-- followed by `motir`→`amethyst` would send every Graphite user to Amethyst.
-- NULL means "the default" and is left alone — the default is now the
-- monochrome `motir`, which is the point of the change. Every other id meant the
-- same palette before and after.
UPDATE "user_appearance_preference"
   SET "palette_id" = CASE "palette_id"
                        WHEN 'motir' THEN 'amethyst'
                        WHEN 'graphite' THEN 'motir'
                      END
 WHERE "palette_id" IN ('motir', 'graphite');

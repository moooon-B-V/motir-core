import { renderMarkdown } from '@/lib/markdown/render';
import { Pill } from '@/components/ui/Pill';
import {
  type FeatureCatalogView as FeatureCatalogModel,
  phaseLabel,
  statusPillVariant,
} from '@/lib/onboarding/directionDoc';

// FeatureCatalogView (7.3.6 / MOTIR-834) — the structured feature catalog,
// rendered READ-ONLY and FOLDED INTO the vision tier (never a separate
// artifact; see design/ai-chat/design-notes.md). The catalog is structured
// data (categories → features, glossary groups → concepts) from the motir-ai
// FeatureCatalog store (7.3.15) — NOT Markdown — so it renders from the typed
// view model; each feature's `descriptionMd` and each concept's `descriptionMd`
// are the only Markdown sub-fields, rendered through the shared pipeline.

export interface FeatureCatalogViewProps {
  catalog: FeatureCatalogModel;
}

export function FeatureCatalogView({ catalog }: FeatureCatalogViewProps) {
  const hasFeatures = catalog.categories.some((c) => c.features.length > 0);
  const hasGlossary = catalog.glossary.some((g) => g.concepts.length > 0);
  if (!hasFeatures && !hasGlossary) return null;

  return (
    <section className="dd-catalog" aria-label="Feature catalog">
      <h2 className="dd-catalog-h">The feature catalog</h2>
      <p className="dd-catalog-sub">
        Everything we&apos;ll build, grouped — with the phase each piece lands in.
      </p>

      {catalog.categories.map((cat) =>
        cat.features.length === 0 ? null : (
          <div className="dd-cat" key={cat.id}>
            <h3 className="dd-cat-title">
              {cat.title}
              <span className="dd-cat-count">
                {cat.features.length} {cat.features.length === 1 ? 'feature' : 'features'}
              </span>
            </h3>
            {cat.features.map((feat) => (
              <div className="dd-feat" key={feat.id}>
                <div className="dd-feat-head">
                  <span className="dd-feat-name">{feat.name}</span>
                  <span className="dd-phase">{phaseLabel(feat.phase)}</span>
                  <Pill status={statusPillVariant(feat.status)}>
                    {feat.status === 'in_progress'
                      ? 'In progress'
                      : feat.status === 'done'
                        ? 'Done'
                        : 'Planned'}
                  </Pill>
                </div>
                {feat.descriptionMd.trim().length > 0 && (
                  <div className="dd-feat-desc wmde-markdown">
                    {renderMarkdown(feat.descriptionMd)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ),
      )}

      {hasGlossary && (
        <div className="dd-glossary">
          <h3 className="dd-cat-title">In plain words</h3>
          {catalog.glossary.map((group) =>
            group.concepts.length === 0 ? null : (
              <div className="dd-gloss-group" key={group.id}>
                {group.concepts.map((concept) => (
                  <div className="dd-gloss-item" key={concept.id}>
                    <span className="dd-gloss-term">
                      {concept.term}
                      {concept.aka && <span className="dd-gloss-aka">aka {concept.aka}</span>}
                    </span>
                    <p className="dd-gloss-def">{concept.descriptionMd}</p>
                    {concept.example && (
                      <p className="dd-gloss-eg">
                        <b>For example:</b> {concept.example}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

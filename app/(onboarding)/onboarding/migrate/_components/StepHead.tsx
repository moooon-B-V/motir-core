// The step header every migrate-wizard panel opens with — the eyebrow, the
// serif heading and the lede (`design/onboarding-migrate/` § 2026-10-12). Its
// own module so the panels that outgrew `MigrateWizard.tsx` (`ConnectPanel`)
// draw the same head without importing the wizard back.
export function StepHead({
  id,
  eyebrow,
  heading,
  body,
}: {
  id?: string;
  eyebrow: string;
  heading: string;
  body: string;
}) {
  return (
    <div className="mb-6 grid gap-2">
      <p className="m-0 flex items-center gap-2 font-mono text-[11px] font-semibold tracking-[0.1em] text-(--el-text-secondary) uppercase">
        <span className="size-2 flex-none rounded-full bg-(--el-highlight)" aria-hidden />
        {eyebrow}
      </p>
      <h2
        id={id}
        className="m-0 font-serif text-[28px] leading-[0.98] font-bold tracking-[-0.03em] text-balance text-(--el-text) md:text-[34px]"
      >
        {heading}
      </h2>
      <p className="m-0 mt-1 max-w-[60ch] text-[15px] leading-normal text-(--el-text-secondary) md:text-[16px]">
        {body}
      </p>
    </div>
  );
}

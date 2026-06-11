// Loading skeleton for the Fields settings page (the 5.3.4 mockup, panel 6:
// header + row skeletons extending the settings skeleton grammar). Pure
// presentational pulse blocks — colour through --el-* fills only.

export default function FieldsSettingsLoading() {
  return (
    <div className="mx-auto flex max-w-[42rem] animate-pulse flex-col gap-6" aria-hidden>
      <header className="flex flex-col gap-2">
        <div className="bg-(--el-muted) h-8 w-32 rounded-(--radius-control)" />
        <div className="bg-(--el-muted) h-4 w-2/3 rounded-(--radius-control)" />
      </header>
      <div className="border-(--el-border) rounded-(--radius-card) border p-(--spacing-card-padding)">
        <div className="mb-4 flex items-center justify-between">
          <div className="bg-(--el-muted) h-4 w-32 rounded-(--radius-control)" />
          <div className="bg-(--el-muted) h-7 w-24 rounded-(--radius-btn)" />
        </div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="bg-(--el-muted) size-8 rounded-(--radius-control)" />
              <div
                className="bg-(--el-muted) h-3.5 rounded-(--radius-control)"
                style={{ width: `${40 + i * 8}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

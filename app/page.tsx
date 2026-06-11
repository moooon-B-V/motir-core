export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="font-serif text-6xl font-semibold tracking-tight">Motir</h1>
      <p className="text-(--el-text-muted) mt-4 text-sm">AI-native project management · GPL-3.0</p>
      <a
        href="/tokens"
        className="mt-8 text-xs underline-offset-4 hover:underline"
        style={{ color: 'var(--el-link)' }}
      >
        view design tokens →
      </a>
    </main>
  );
}

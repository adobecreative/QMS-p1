import { icons, type LucideProps } from "lucide-react";

/** Render a lucide icon by name (names are stored in the DB, e.g. Chapter.icon). */
export function Icon({ name, ...props }: LucideProps & { name: string }) {
  const Cmp = icons[name as keyof typeof icons] ?? icons.BookOpen;
  return <Cmp aria-hidden {...props} />;
}

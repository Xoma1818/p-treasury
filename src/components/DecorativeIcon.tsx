import type { LucideIcon } from "lucide-react";

type IconSize = "inline" | "control" | "navigation";

const iconSizes: Record<IconSize, number> = {
  inline: 15,
  control: 17,
  navigation: 18,
};

/** Иконка сопровождает подпись или кнопку с собственным доступным именем. */
export function DecorativeIcon({
  icon: Icon,
  size = "navigation",
  className,
}: {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
}) {
  return <Icon size={iconSizes[size]} strokeWidth={1.75} className={className} aria-hidden="true" focusable="false" />;
}

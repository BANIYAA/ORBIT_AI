import React from "react";
import * as Lucide from "lucide-react";
const icons = ['TriangleAlert', 'Orbit', 'Sparkles', 'ShieldCheck', 'CircleHelp', 'Calendar', 'Clock', 'CircleAlert', 'CirclePlus', 'Activity', 'Target', 'Hourglass', 'Flame', 'ClipboardList', 'CircleCheck', 'Circle', 'Trash2', 'Star', 'ChevronDown', 'SquareCheck', 'ListTodo', 'Pencil', 'CalendarHeart', 'Check', 'Plus', 'ArrowRight', 'Lightbulb', 'TrendingUp', 'TrendingDown', 'Minus'];

const missing = icons.filter(i => !(i in Lucide));
if (missing.length > 0) {
  console.log("MISSING ICONS:", missing);
  process.exit(1);
} else {
  console.log("All icons exist.");
}

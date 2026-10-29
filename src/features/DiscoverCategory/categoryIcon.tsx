import { CATEGORY_LUCIDE_ICON_NAMES, parseCategoryIcon } from '@lobehub/market-types';
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  AppleIcon,
  BadgeDollarSignIcon,
  BookIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  BriefcaseIcon,
  CalendarIcon,
  ChartNoAxesColumnIcon,
  CircleHelpIcon,
  CloudIcon,
  CodeIcon,
  CoffeeIcon,
  CompassIcon,
  DatabaseIcon,
  DollarSignIcon,
  DramaIcon,
  FileTextIcon,
  FolderIcon,
  GamepadIcon,
  GitBranchIcon,
  GlobeIcon,
  GraduationCapIcon,
  HammerIcon,
  HeartHandshakeIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  LanguagesIcon,
  LaughIcon,
  LayersIcon,
  LeafIcon,
  LightbulbIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  MicIcon,
  MicroscopeIcon,
  MonitorIcon,
  NetworkIcon,
  NewspaperIcon,
  PaletteIcon,
  PencilIcon,
  PlayIcon,
  PrinterIcon,
  PuzzleIcon,
  RocketIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShapesIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShoppingCartIcon,
  SmartphoneIcon,
  SparklesIcon,
  SquareCheckIcon,
  SquareTerminalIcon,
  StarIcon,
  TerminalIcon,
  TruckIcon,
  UserIcon,
  UsersIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
} from 'lucide-react';
import { type Ref, useState } from 'react';

import type { CategoryLucideIconName } from '@/types/discover';

/** Shown for a category without an icon, with an unknown one, or whose image fails to load. */
export const GenericCategoryIcon: LucideIcon = ShapesIcon;

/**
 * Every icon name Market accepts for a category (`CATEGORY_LUCIDE_ICON_NAMES`).
 * Typed as a complete record, so a name added to Market fails the build here
 * until it is mapped.
 */
const LUCIDE_CATEGORY_ICONS: Record<CategoryLucideIconName, LucideIcon> = {
  'apple': AppleIcon,
  'badge-dollar-sign': BadgeDollarSignIcon,
  'book': BookIcon,
  'book-open': BookOpenIcon,
  'bot': BotIcon,
  'brain': BrainIcon,
  'briefcase': BriefcaseIcon,
  'calendar': CalendarIcon,
  'chart-no-axes-column': ChartNoAxesColumnIcon,
  'circle-help': CircleHelpIcon,
  'cloud': CloudIcon,
  'code': CodeIcon,
  'coffee': CoffeeIcon,
  'compass': CompassIcon,
  'database': DatabaseIcon,
  'dollar-sign': DollarSignIcon,
  'drama': DramaIcon,
  'file-text': FileTextIcon,
  'folder': FolderIcon,
  'gamepad': GamepadIcon,
  'git-branch': GitBranchIcon,
  'globe': GlobeIcon,
  'graduation-cap': GraduationCapIcon,
  'hammer': HammerIcon,
  'heart': HeartIcon,
  'heart-handshake': HeartHandshakeIcon,
  'house': HouseIcon,
  'image': ImageIcon,
  'languages': LanguagesIcon,
  'laugh': LaughIcon,
  'layers': LayersIcon,
  'leaf': LeafIcon,
  'lightbulb': LightbulbIcon,
  'map': MapIcon,
  'megaphone': MegaphoneIcon,
  'message-circle': MessageCircleIcon,
  'mic': MicIcon,
  'microscope': MicroscopeIcon,
  'monitor': MonitorIcon,
  'network': NetworkIcon,
  'newspaper': NewspaperIcon,
  'palette': PaletteIcon,
  'pencil': PencilIcon,
  'play': PlayIcon,
  'printer': PrinterIcon,
  'puzzle': PuzzleIcon,
  'rocket': RocketIcon,
  'search': SearchIcon,
  'server': ServerIcon,
  'settings': SettingsIcon,
  'shield': ShieldIcon,
  'shield-check': ShieldCheckIcon,
  'shopping-cart': ShoppingCartIcon,
  'smartphone': SmartphoneIcon,
  'sparkles': SparklesIcon,
  'square-check': SquareCheckIcon,
  'square-terminal': SquareTerminalIcon,
  'star': StarIcon,
  'terminal': TerminalIcon,
  'truck': TruckIcon,
  'user': UserIcon,
  'users': UsersIcon,
  'workflow': WorkflowIcon,
  'wrench': WrenchIcon,
  'zap': ZapIcon,
};

const imageIcons = new Map<string, LucideIcon>();

/**
 * An uploaded category image drawn in the box of a lucide icon, so it drops
 * into `Icon` and every other `icon` prop unchanged. A broken image falls back
 * to the generic icon instead of leaving a hole in the menu.
 */
const imageIcon = (src: string): LucideIcon => {
  const cached = imageIcons.get(src);
  if (cached) return cached;

  const ImageIcon = (({
    className,
    ref,
    size = 24,
    style,
    ...rest
  }: LucideProps & { ref?: Ref<SVGSVGElement> }) => {
    const [failed, setFailed] = useState(false);
    if (failed)
      return (
        <GenericCategoryIcon className={className} ref={ref} size={size} style={style} {...rest} />
      );

    return (
      <img
        aria-hidden
        alt=""
        className={className}
        height={size}
        src={src}
        style={{ flex: 'none', objectFit: 'contain', ...style }}
        width={size}
        onError={() => setFailed(true)}
      />
    );
  }) as unknown as LucideIcon;
  ImageIcon.displayName = 'CategoryImageIcon';

  imageIcons.set(src, ImageIcon);
  return ImageIcon;
};

/**
 * The component for a Market category icon, from the shared `parseCategoryIcon`
 * reading: a lucide name from the static table, an HTTP(S) URL as an image,
 * anything else (null, unknown name, other schemes) as the generic icon.
 */
export const resolveCategoryIcon = (icon: string | null | undefined): LucideIcon => {
  const parsed = parseCategoryIcon(icon, CATEGORY_LUCIDE_ICON_NAMES);

  switch (parsed.type) {
    case 'lucide': {
      // Only names on the allowlist come back as `lucide`, and the table covers it.
      return LUCIDE_CATEGORY_ICONS[parsed.name as CategoryLucideIconName];
    }
    case 'image': {
      return imageIcon(parsed.url);
    }
    default: {
      return GenericCategoryIcon;
    }
  }
};

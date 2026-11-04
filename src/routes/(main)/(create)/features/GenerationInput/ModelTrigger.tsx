import { COMPOSER_AGENT_ONLY_LAYOUT } from '@lobechat/business-const';
import { ActionIcon, Button, Icon } from '@lobehub/ui';
import { ChevronDown } from 'lucide-react';
import { type ComponentProps, type Ref } from 'react';

import { ModelIcon } from '@/components/LobeIcons';

interface ModelGroup {
  children: { displayName?: string; id: string }[];
}

interface ModelTriggerProps extends Omit<ComponentProps<typeof Button>, 'ref'> {
  enabledList?: ModelGroup[];
  model?: string | null;
  ref?: Ref<HTMLButtonElement>;
}

const resolveModelName = (model: string, enabledList: ModelGroup[] = []) =>
  enabledList.flatMap((group) => group.children).find((item) => item.id === model)?.displayName ||
  model;

/**
 * The creation model picker's trigger. It takes the panel's trigger props, so it
 * spreads the rest. The agent-only layout names the model, so a person can tell
 * which one is selected without opening the menu.
 */
const ModelTrigger = ({ enabledList, model, ref, ...rest }: ModelTriggerProps) => {
  const icon = <ModelIcon model={model ?? ''} size={COMPOSER_AGENT_ONLY_LAYOUT ? 16 : 22} />;

  if (!COMPOSER_AGENT_ONLY_LAYOUT)
    return <ActionIcon {...(rest as object)} icon={icon} size={{ blockSize: 36, size: 20 }} />;

  const name = model ? resolveModelName(model, enabledList) : '';

  return (
    <Button
      {...rest}
      aria-label={name || undefined}
      data-brand-slot={'create-model-select'}
      icon={icon}
      ref={ref}
      type={'text'}
    >
      {name}
      <Icon icon={ChevronDown} size={16} />
    </Button>
  );
};

export default ModelTrigger;

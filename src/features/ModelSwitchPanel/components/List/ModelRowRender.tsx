import { Flexbox } from '@lobehub/ui';
import { type AiModelForSelect } from 'model-bank';
import { memo } from 'react';

import { ModelItemRender } from '@/components/ModelSelect';

import { useModelEffortLabel } from '../../hooks/useModelEffortLabel';
import { ModelFavoriteButton } from './ModelFavoriteButton';
import { ImageOutputMark, ModelRowMeta } from './ModelRowMeta';

interface ModelRowRenderProps {
  /**
   * Effort label from the host for the active row. It wins over the saved
   * per-model default because a topic can pin its own effort for that model.
   */
  activeEffortLabel?: string;
  isActive?: boolean;
  model: AiModelForSelect;
  newLabel: string;
  proBadgeLabel?: string;
  provider: string;
  /** Every provider offering this row's model; defaults to `provider` alone. */
  providers?: readonly string[];
}

/** One model row of the switch panel: name, reasoning effort, comparison meta and star. */
export const ModelRowRender = memo<ModelRowRenderProps>(
  ({
    activeEffortLabel,
    isActive,
    model,
    newLabel,
    proBadgeLabel,
    provider,
    providers = [provider],
  }) => {
    const effortLabel = useModelEffortLabel(model.id, provider);

    return (
      <ModelItemRender
        {...model}
        {...model.abilities}
        nameSuffix={model.abilities?.imageOutput && <ImageOutputMark />}
        newBadgeLabel={newLabel}
        proBadgeLabel={proBadgeLabel}
        secondaryText={(isActive && activeEffortLabel) || effortLabel}
        extra={
          <Flexbox horizontal align={'center'} gap={4} style={{ flex: 'none' }}>
            <ModelRowMeta model={model} provider={provider} />
            <ModelFavoriteButton model={model.id} providers={providers} />
          </Flexbox>
        }
      />
    );
  },
);

ModelRowRender.displayName = 'ModelRowRender';

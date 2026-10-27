import { Flexbox, Skeleton, cssVar } from '@lobehub/ui';

const ScheduledTasksSkeleton = () => (
  <Flexbox aria-busy horizontal flex={1} style={{ minWidth: 0, minHeight: 0 }}>
    <Flexbox
      gap={40}
      padding={20}
      style={{
        width: 248,
        maxWidth: '40%',
        borderInlineEnd: `1px solid ${cssVar.colorBorderSecondary}`,
      }}
    >
      <Skeleton.Text width={100} />
      <Skeleton.Text rows={6} />
    </Flexbox>
    <Flexbox flex={1} gap={32} padding={40} style={{ minWidth: 0 }}>
      <Skeleton.Text width="40%" />
      <Skeleton.Text rows={3} />
      <Skeleton.Text rows={4} />
      <Skeleton.Text rows={3} />
    </Flexbox>
  </Flexbox>
);
export default ScheduledTasksSkeleton;

import { Flexbox, Skeleton, cssVar } from '@lobehub/ui';

const ScheduledTasksSkeleton = ({ showWelcome = false }: { showWelcome?: boolean }) => (
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
      {showWelcome ? (
        <Flexbox flex={1} align="center" justify="center" gap={32}>
          <Skeleton style={{ width: 64, height: 64, borderRadius: '50%' }} />
          <Skeleton.Text width={240} />
          <Skeleton style={{ width: 120, height: 40, borderRadius: 24 }} />
          <Flexbox horizontal wrap="wrap" gap={16} style={{ width: '100%', maxWidth: 720 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} style={{ width: 'calc(50% - 8px)', height: 76 }} />
            ))}
          </Flexbox>
        </Flexbox>
      ) : (
        <>
          <Skeleton.Text width="40%" />
          <Skeleton.Text rows={3} />
          <Skeleton.Text rows={4} />
          <Skeleton.Text rows={3} />
        </>
      )}
    </Flexbox>
  </Flexbox>
);
export default ScheduledTasksSkeleton;

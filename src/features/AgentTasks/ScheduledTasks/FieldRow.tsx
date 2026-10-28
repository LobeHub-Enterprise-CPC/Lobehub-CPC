import type { ReactNode } from 'react';

import { styles } from './style';

export const FieldRow = ({
  children,
  id,
  label,
}: {
  children: ReactNode;
  id?: string;
  label: string;
}) => (
  <div className={styles.row}>
    <label htmlFor={id}>{label}</label>
    {children}
  </div>
);

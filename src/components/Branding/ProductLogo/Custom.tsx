import {
  BRANDING_LOGO_DARK_URL,
  BRANDING_LOGO_URL,
  BRANDING_NAME,
  BRANDING_TEXT_LOGO_DARK_URL,
  BRANDING_TEXT_LOGO_URL,
  BRANDING_WORDMARK_DARK_URL,
  BRANDING_WORDMARK_URL,
} from '@lobechat/business-const';
import { type IconType } from '@lobehub/icons';
import { type FlexboxProps } from '@lobehub/ui';
import { Flexbox } from '@lobehub/ui';
import { type LobeChatProps } from '@lobehub/ui/brand';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ReactNode } from 'react';
import { memo } from 'react';

import { useIsDark } from '@/hooks/useIsDark';
import { type ImageProps } from '@/libs/next/Image';
import Image from '@/libs/next/Image';

const styles = createStaticStyles(({ css }) => {
  return {
    extraTitle: css`
      font-weight: 300;
      white-space: nowrap;
    `,
  };
});

const CustomTextLogo = memo<FlexboxProps & { size: number }>(({ size, style, ...rest }) => {
  return (
    <Flexbox
      height={size}
      style={{
        fontSize: size / 1.5,
        fontWeight: 'bolder',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {BRANDING_NAME}
    </Flexbox>
  );
});

const CustomImageLogo = memo<
  Omit<ImageProps, 'alt' | 'src'> & { size: number; wordmark?: 'text' | 'combine' }
>(({ size, wordmark, ...rest }) => {
  const isDarkMode = useIsDark();
  const light =
    wordmark === 'text'
      ? BRANDING_TEXT_LOGO_URL
      : wordmark
        ? BRANDING_WORDMARK_URL
        : BRANDING_LOGO_URL;
  const dark =
    wordmark === 'text'
      ? BRANDING_TEXT_LOGO_DARK_URL
      : wordmark
        ? BRANDING_WORDMARK_DARK_URL
        : BRANDING_LOGO_DARK_URL;
  return (
    <Image
      alt={BRANDING_NAME}
      height={size}
      src={(isDarkMode && dark) || light}
      unoptimized={true}
      width={wordmark ? undefined : size}
      {...rest}
    />
  );
});

const Divider: IconType = (({ ref, size = '1em', style, ...rest }) => (
  <svg
    fill="none"
    height={size}
    ref={ref}
    shapeRendering="geometricPrecision"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flex: 'none', lineHeight: 1, ...style }}
    viewBox="0 0 24 24"
    width={size}
    {...rest}
  >
    <path d="M16.88 3.549L7.12 20.451" />
  </svg>
)) as IconType;

const CustomLogo = memo<LobeChatProps>(({ extra, size = 32, className, style, type, ...rest }) => {
  let logoComponent: ReactNode;
  const logoClassName = extra ? undefined : className;

  switch (type) {
    case '3d':
    case 'flat': {
      logoComponent = (
        <CustomImageLogo className={logoClassName} size={size} style={style} {...rest} />
      );
      break;
    }
    case 'mono': {
      logoComponent = (
        <CustomImageLogo
          className={logoClassName}
          size={size}
          style={{ filter: 'grayscale(100%)', ...style }}
          {...rest}
        />
      );
      break;
    }
    case 'text': {
      if (BRANDING_TEXT_LOGO_URL) {
        logoComponent = (
          <CustomImageLogo
            className={logoClassName}
            size={size}
            style={style}
            wordmark="text"
            {...rest}
          />
        );
        break;
      }
      logoComponent = (
        <CustomTextLogo className={logoClassName} size={size} style={style} {...rest} />
      );
      break;
    }
    case 'combine': {
      if (BRANDING_WORDMARK_URL) {
        logoComponent = (
          <CustomImageLogo
            className={logoClassName}
            size={size}
            style={style}
            wordmark="combine"
            {...rest}
          />
        );
        break;
      }
      logoComponent = (
        <>
          <CustomImageLogo size={size} />
          <CustomTextLogo size={size} style={{ marginLeft: Math.round(size / 4) }} />
        </>
      );

      if (!extra)
        logoComponent = (
          <Flexbox
            horizontal
            align={'center'}
            className={className}
            flex={'none'}
            style={style}
            {...rest}
          >
            {logoComponent}
          </Flexbox>
        );

      break;
    }
    default: {
      logoComponent = (
        <CustomImageLogo className={logoClassName} size={size} style={style} {...rest} />
      );
      break;
    }
  }

  if (!extra) return logoComponent;

  const extraSize = Math.round((size / 3) * 1.9);

  return (
    <Flexbox horizontal align={'center'} className={className} flex={'none'} {...rest}>
      {logoComponent}
      <Divider size={extraSize} style={{ color: cssVar.colorFill }} />
      <div className={styles.extraTitle} style={{ fontSize: extraSize }}>
        {extra}
      </div>
    </Flexbox>
  );
});

export default CustomLogo;

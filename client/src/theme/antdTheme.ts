import type { ThemeConfig } from 'antd';

const antdTheme: ThemeConfig = {
  token: {
    // 品牌色
    colorPrimary: '#1A6B6B',
    colorError: '#C23B35',
    colorWarning: '#C47F17',
    colorSuccess: '#2E8B57',
    colorInfo: '#1A6B6B',

    // 背景
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#FAFAF7',
    colorBgElevated: '#FFFFFF',
    colorBgSpotlight: '#141413',

    // 边框
    colorBorder: '#E0E0D8',
    colorBorderSecondary: '#EDEDE7',

    // 文字
    colorText: '#141413',
    colorTextSecondary: '#3D3D39',
    colorTextTertiary: '#7A7A72',
    colorTextQuaternary: '#A3A399',

    // 填充
    colorFill: '#EDEDE7',
    colorFillSecondary: '#F5F5F0',
    colorFillTertiary: '#FAFAF7',

    // 字体
    fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", Inter, system-ui, sans-serif',
    fontSize: 14,

    // 圆角
    borderRadius: 6,
    borderRadiusSM: 4,
    borderRadiusLG: 10,
    borderRadiusXS: 2,

    // 阴影
    boxShadow: '0 1px 2px rgba(16, 24, 40, .04), 0 1px 3px rgba(16, 24, 40, .06)',
    boxShadowSecondary: '0 4px 8px rgba(16, 24, 40, .06), 0 2px 4px rgba(16, 24, 40, .04)',

    // 动效
    motionDurationFast: '120ms',
    motionDurationMid: '200ms',
    motionDurationSlow: '320ms',
    motionEaseInOut: 'cubic-bezier(.2, .8, .2, 1)',
  },
  components: {
    Button: {
      primaryColor: '#FFFFFF',
      borderRadius: 6,
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: '#EAF3F3',
      itemSelectedColor: '#1A6B6B',
      itemHoverBg: '#F5F5F0',
    },
    Input: {
      activeBorderColor: '#1A6B6B',
      hoverBorderColor: '#3F8A8A',
    },
    Layout: {
      siderBg: '#FFFFFF',
      headerBg: '#FFFFFF',
      bodyBg: '#FAFAF7',
    },
  },
};

export default antdTheme;

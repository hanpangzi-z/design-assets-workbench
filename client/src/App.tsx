import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import AntdApp from 'antd/es/app';
import ConfigProvider from 'antd/es/config-provider';
import zhCN from 'antd/es/locale/zh_CN';
import antdTheme from '@/theme/antdTheme';
import router from '@/router';

export default function App() {
  useEffect(() => {
    const linkId = 'custom-fonts-css';
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = '/api/v1/fonts/css';
  }, []);

  return (
    <ConfigProvider theme={antdTheme} locale={zhCN}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
}

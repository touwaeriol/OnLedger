import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App.jsx';
import './styles.css';

dayjs.locale('zh-cn');


function Root() {
  const [dark, setDark] = useState(() => localStorage.getItem('onledger.dark') === '1');
  const toggleDark = (v) => {
    setDark(v);
    localStorage.setItem('onledger.dark', v ? '1' : '0');
  };
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 8 },
      }}
    >
      <AntApp>
        <App dark={dark} onToggleDark={toggleDark} />
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);

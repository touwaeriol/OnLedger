import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, Typography, App } from 'antd';
import { api } from '../api';

const { Link, Text } = Typography;

export default function SettingsModal({ open, onClose }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  useEffect(() => {
    if (open) api.getSettings().then((s) => form.setFieldsValue(s));
  }, [open, form]);

  const onOk = async () => {
    setSaving(true);
    try {
      await api.saveSettings(form.getFieldsValue());
      message.success('设置已保存');
      onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const open_ = (url) => (e) => {
    e.preventDefault();
    api.openExternal(url);
  };

  return (
    <Modal title="设置" open={open} onCancel={onClose} onOk={onOk} confirmLoading={saving} okText="保存" destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label="Etherscan API Key"
          name="etherscanApiKey"
          extra={
            <>
              用于 Ethereum / BSC / Polygon / Arbitrum / Base / Optimism，一个 Key 通用。
              <Link href="#" onClick={open_('https://etherscan.io/apis')}>
                免费申请
              </Link>
              <br />
              <Text type="secondary">注：Etherscan 免费套餐可能不包含部分链（如 BSC、Base、Optimism），需付费套餐。</Text>
            </>
          }
        >
          <Input.Password placeholder="必填（查询 EVM 链时）" autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="TronGrid API Key"
          name="tronApiKey"
          extra={
            <>
              可选。不填也能查询，但有频率限制。
              <Link href="#" onClick={open_('https://www.trongrid.io/')}>
                申请
              </Link>
            </>
          }
        >
          <Input.Password placeholder="可选" autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="网络代理"
          name="proxy"
          extra="留空则使用系统代理。示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
        >
          <Input placeholder="留空 = 跟随系统代理" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

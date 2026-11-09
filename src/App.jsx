import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Layout,
  Card,
  Form,
  Select,
  Input,
  AutoComplete,
  Button,
  Row,
  Col,
  Statistic,
  Alert,
  Flex,
  Switch,
  Tooltip,
  Typography,
  Empty,
  App as AntApp,
  theme,
} from 'antd';
import {
  SearchOutlined,
  SettingOutlined,
  DownloadOutlined,
  WalletOutlined,
  MoonOutlined,
  SunOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import SettingsModal from './components/SettingsModal.jsx';
import { api } from './api';
import LedgerTable from './components/LedgerTable.jsx';
import { formatUnits, prettyAmount, summarize, loadHistory, pushHistory, clearHistory, shortAddr } from './utils';

const { Header, Content } = Layout;
const { Text } = Typography;

const CUSTOM = '__custom__';
const LOAD_ALL_MAX_PAGES = 100;

export default function App({ dark, onToggleDark }) {
  const { token: themeToken } = theme.useToken();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [chains, setChains] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // {req, records, nextCursor, balance, balanceSymbol, balanceError}
  const cancelLoadAll = useRef(false);
  const keySeq = useRef(0);

  const chainId = Form.useWatch('chainId', form);
  const tokenValue = Form.useWatch('token', form);
  const chain = chains.find((c) => c.id === chainId);

  useEffect(() => {
    api.listChains().then((list) => {
      setChains(list);
      form.setFieldsValue({ chainId: list[0].id, token: list[0].tokens[0].symbol });
    });
  }, [form]);

  const tokenOptions = useMemo(() => {
    if (!chain) return [];
    const opts = chain.tokens.map((t) => ({
      value: t.symbol,
      label: t.native ? `${t.symbol}（原生币）` : `${t.symbol}`,
    }));
    if (chain.type !== 'btc') opts.push({ value: CUSTOM, label: '自定义合约地址…' });
    return opts;
  }, [chain]);

  const addressOptions = useMemo(
    () =>
      history
        .filter((h) => h.chainId === chainId)
        .map((h) => ({
          value: h.address,
          label: (
            <Flex justify="space-between">
              <Text className="mono">{shortAddr(h.address, 10, 8)}</Text>
              <Text type="secondary">{h.tokenLabel}</Text>
            </Flex>
          ),
        }))
        .filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i),
    [history, chainId]
  );

  const onChainChange = (id) => {
    const c = chains.find((x) => x.id === id);
    form.setFieldsValue({ token: c.tokens[0].symbol, contract: undefined });
    setError('');
    if (form.getFieldValue('address')) form.validateFields(['address']).catch(() => {});
  };

  // 校验器从表单读取当前链，避免闭包中拿到切换前的链
  const addressRule = (label) => ({
    validator: (_, v) => {
      const c = chains.find((x) => x.id === form.getFieldValue('chainId'));
      if (!v || !c || new RegExp(c.addressPattern).test(v.trim())) return Promise.resolve();
      return Promise.reject(new Error(label === '地址' ? `不是有效的 ${c.name} 地址` : `${label}格式不正确`));
    },
  });

  const withKeys = (records) => records.map((r) => ({ ...r, _key: ++keySeq.current }));

  const runQuery = async () => {
    setHistoryOpen(false); // 收起地址历史下拉
    let values;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const req = {
      chainId: values.chainId,
      address: values.address.trim(),
      token: values.token === CUSTOM ? { contract: values.contract.trim() } : { symbol: values.token },
    };
    cancelLoadAll.current = true;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await api.queryLedger(req);
      setResult({ ...res, req, records: withKeys(res.records) });
      const tokenLabel = req.token.symbol || res.records[0]?.symbol || shortAddr(req.token.contract);
      pushHistory({
        chainId: req.chainId,
        address: req.address,
        tokenKey: req.token.symbol || `c:${req.token.contract}`,
        tokenLabel,
      });
      setHistory(loadHistory());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!result?.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.queryLedger({ ...result.req, cursor: result.nextCursor });
      setResult((prev) => ({ ...prev, records: [...prev.records, ...withKeys(res.records)], nextCursor: res.nextCursor }));
    } catch (e) {
      message.error(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadAll = async () => {
    if (!result?.nextCursor) return;
    cancelLoadAll.current = false;
    setLoadingMore(true);
    let cursor = result.nextCursor;
    const req = result.req;
    try {
      for (let i = 0; i < LOAD_ALL_MAX_PAGES && cursor && !cancelLoadAll.current; i++) {
        const res = await api.queryLedger({ ...req, cursor });
        if (cancelLoadAll.current) break;
        cursor = res.nextCursor;
        setResult((prev) => ({ ...prev, records: [...prev.records, ...withKeys(res.records)], nextCursor: res.nextCursor }));
        await new Promise((r) => setTimeout(r, 250)); // 避免触发免费 API 频率限制
      }
    } catch (e) {
      message.error(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    if (!result?.records.length) return;
    const header = ['时间', '类型', '金额', '币种', '发送方', '接收方', '手续费', '手续费币种', '状态', '区块', '交易哈希', '浏览器链接'];
    const dirText = { in: '转入', out: '转出', self: '自转' };
    const statusText = { success: '成功', failed: '失败', pending: '待确认' };
    const rows = result.records.map((r) => [
      r.time ? dayjs(r.time).format('YYYY-MM-DD HH:mm:ss') : '',
      dirText[r.direction] || r.direction,
      formatUnits(r.value, r.decimals),
      r.symbol,
      r.from,
      r.to,
      r.fee ? formatUnits(r.fee, r.feeDecimals) : '',
      r.fee ? r.feeSymbol : '',
      statusText[r.status] || r.status,
      r.block ?? '',
      r.hash,
      r.explorerUrl,
    ]);
    const sym = result.records[0].symbol;
    const name = `${result.req.chainId}_${sym}_${result.req.address.slice(0, 10)}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    try {
      const file = await api.exportCsv(name, [header, ...rows]);
      if (file) message.success(`已导出到 ${file}`);
    } catch (e) {
      message.error(e.message);
    }
  };

  const sum = useMemo(() => (result ? summarize(result.records) : null), [result]);
  const sym = sum?.symbol || result?.balanceSymbol || '';

  return (
    <Layout className="app-layout">
      <Header className="app-header" style={{ background: themeToken.colorBgContainer, borderBottom: `1px solid ${themeToken.colorBorderSecondary}` }}>
        <div className="app-title" style={{ color: themeToken.colorText }}>
          <WalletOutlined style={{ color: themeToken.colorPrimary }} />
          OnLedger · 链上账单查询
        </div>
        <Flex gap={12} align="center">
          <Switch checked={dark} onChange={onToggleDark} checkedChildren={<MoonOutlined />} unCheckedChildren={<SunOutlined />} />
          {api.isDesktop && (
            <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              设置
            </Button>
          )}
        </Flex>
      </Header>

      <Content className="app-content">
        <Card size="small">
          <Form form={form} layout="vertical" requiredMark={false} onFinish={runQuery}>
            <Row gutter={12} align="top">
              <Col xs={12} md={5}>
                <Form.Item label="链" name="chainId" style={{ marginBottom: 0 }}>
                  <Select
                    options={chains.map((c) => ({ value: c.id, label: c.name }))}
                    onChange={onChainChange}
                    loading={!chains.length}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="币种" name="token" style={{ marginBottom: 0 }}>
                  <Select options={tokenOptions} />
                </Form.Item>
              </Col>
              {tokenValue === CUSTOM && (
                <Col xs={24} md={6}>
                  <Form.Item
                    label="代币合约地址"
                    name="contract"
                    style={{ marginBottom: 0 }}
                    rules={[
                      { required: true, message: '请输入合约地址' },
                      addressRule('合约地址'),
                    ]}
                  >
                    <Input className="mono" placeholder={chain?.type === 'tron' ? 'T...' : '0x...'} allowClear />
                  </Form.Item>
                </Col>
              )}
              <Col xs={24} md={tokenValue === CUSTOM ? 6 : 12} flex="auto">
                <Form.Item
                  label="地址"
                  name="address"
                  style={{ marginBottom: 0 }}
                  rules={[
                    { required: true, message: '请输入要查询的地址' },
                    addressRule('地址'),
                  ]}
                >
                  <AutoComplete
                    options={addressOptions}
                    open={historyOpen && addressOptions.length > 0}
                    onOpenChange={setHistoryOpen}
                    filterOption={(input, opt) => opt.value.toLowerCase().includes(input.toLowerCase())}
                    popupRender={(menu) => (
                      <>
                        {menu}
                        {addressOptions.length > 0 && (
                          <Button
                            type="link"
                            size="small"
                            icon={<DeleteOutlined />}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              clearHistory();
                              setHistory([]);
                            }}
                          >
                            清空查询历史
                          </Button>
                        )}
                      </>
                    )}
                  >
                    <Input
                      className="mono"
                      allowClear
                      placeholder={chain?.type === 'evm' ? '0x...' : chain?.type === 'tron' ? 'T...' : 'bc1... / 1... / 3...'}
                    />
                  </AutoComplete>
                </Form.Item>
              </Col>
              <Col xs={24} md={3}>
                <Form.Item label=" " colon={false} style={{ marginBottom: 0 }}>
                  <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading} block>
                    查询
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>

        {error && <Alert type="error" showIcon title="查询失败" description={error} closable={{ onClose: () => setError('') }} />}

        {result && (
          <Row gutter={16}>
            <Col xs={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={
                    result.balanceError ? (
                      <Tooltip title={result.balanceError}>当前余额（获取失败）</Tooltip>
                    ) : (
                      '当前余额'
                    )
                  }
                  value={result.balance != null ? prettyAmount(result.balance) : '-'}
                  suffix={sym}
                />
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={`转入（${sum.inCount} 笔）`}
                  value={prettyAmount(formatUnits(sum.inSum, sum.decimals))}
                  suffix={sym}
                  styles={{ content: { color: '#389e0d' } }}
                />
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small">
                <Statistic
                  title={`转出（${sum.outCount} 笔）`}
                  value={prettyAmount(formatUnits(sum.outSum, sum.decimals))}
                  suffix={sym}
                  styles={{ content: { color: '#cf1322' } }}
                />
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small">
                <Statistic
                  title="手续费合计"
                  value={sum.feeSum ? formatUnits(sum.feeSum, sum.feeDecimals) : '-'}
                  suffix={sum.feeSum ? sum.feeSymbol : ''}
                />
              </Card>
            </Col>
          </Row>
        )}

        <Card
          size="small"
          title="账单明细"
          extra={
            <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!result?.records.length}>
              导出 CSV
            </Button>
          }
        >
          {result || loading ? (
            <>
              {result && (
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                  统计基于已加载的 {result.records.length} 条记录{result.nextCursor ? '，还有更多记录未加载' : '（已全部加载）'}。
                </Text>
              )}
              <LedgerTable
                records={result?.records || []}
                loading={loading}
                footer={
                  result?.nextCursor
                    ? () => (
                        <Flex justify="center" gap={12}>
                          <Button onClick={loadMore} loading={loadingMore}>
                            加载更多
                          </Button>
                          {loadingMore ? (
                            <Button onClick={() => (cancelLoadAll.current = true)}>停止</Button>
                          ) : (
                            <Button onClick={loadAll}>加载全部</Button>
                          )}
                        </Flex>
                      )
                    : undefined
                }
              />
            </>
          ) : (
            <Empty description="选择链和币种，输入地址后点击查询" />
          )}
        </Card>
      </Content>

      {api.isDesktop && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </Layout>
  );
}

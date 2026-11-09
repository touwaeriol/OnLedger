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
  Tag,
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
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import SettingsModal from './components/SettingsModal.jsx';
import LedgerTable from './components/LedgerTable.jsx';
import FilterPanel, { RANGE_PRESETS } from './components/FilterPanel.jsx';
import { api } from './api';
import {
  formatUnits,
  prettyAmount,
  summarize,
  loadHistory,
  pushHistory,
  clearHistory,
  shortAddr,
  parseUnits,
  amountForUsd,
  loadLast,
  saveLast,
} from './utils';

const { Header, Content } = Layout;
const { Text } = Typography;

const CUSTOM = '__custom__';
const LOAD_ALL_MAX_PAGES = 100;
const RANGE_AUTO_MAX_PAGES = 20; // 选择时间区间时自动加载的分页上限（节省上游配额），不够可手动继续
const MIN_USD = 1; // 默认过滤小于 1 美元的交易

// 未确认交易没有时间，按当前时间算
const recTime = (r) => r.time ?? Date.now();

function oldestTime(records) {
  let t = Infinity;
  for (const r of records) if (r.time != null && r.time < t) t = r.time;
  return t;
}

export default function App({ dark, onToggleDark }) {
  const { token: themeToken } = theme.useToken();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [chains, setChains] = useState([]);
  const [prices, setPrices] = useState({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // {req, records, nextCursor, balance, balanceSymbol, balanceError}
  const cancelLoadAll = useRef(false);
  const keySeq = useRef(0);
  const resultRef = useRef(null); // 最新的查询结果（循环加载时读取，避免闭包拿到旧值）
  const queryGen = useRef(0); // 每次新查询 +1，用于中止上一次的后台加载
  const loopRunning = useRef(false);

  // 筛选
  const [rangeKey, setRangeKey] = useState('all'); // all | day | week | month | quarter | custom
  const [range, setRange] = useState(null); // [dayjs, dayjs] | null
  const rangeRef = useRef(null);
  const [amountOn, setAmountOn] = useState(true);
  const [minAmount, setMinAmount] = useState('');
  const [direction, setDirection] = useState('all');
  const [keyword, setKeyword] = useState('');

  // 所有对 result 的修改都经过这里：先同步更新 ref，再触发渲染
  const updateResult = (updater) => {
    const next = typeof updater === 'function' ? updater(resultRef.current) : updater;
    resultRef.current = next;
    setResult(next);
  };

  const chainId = Form.useWatch('chainId', form);
  const tokenValue = Form.useWatch('token', form);
  const chain = chains.find((c) => c.id === chainId);

  useEffect(() => {
    api.listChains().then((list) => {
      setChains(list);
      // 恢复上次使用的链和币种；网页版未配置 Key 的链 available=false，桌面版没有该字段视为可用
      const usable = (c) => c && c.available !== false;
      const last = loadLast();
      const lastChain = last && list.find((c) => c.id === last.chainId);
      const first = usable(lastChain) ? lastChain : list.find(usable) || list[0];
      let token = first.tokens[0].symbol;
      let contract;
      if (first === lastChain) {
        if (last.token === CUSTOM && typeof last.contract === 'string') {
          token = CUSTOM;
          contract = last.contract;
        } else if (first.tokens.some((t) => t.symbol === last.token)) {
          token = last.token;
        }
      }
      form.setFieldsValue({ chainId: first.id, token, contract });
    });
    api
      .getPrices()
      .then((p) => setPrices(p?.prices || {}))
      .catch(() => {});
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

  const chainHistory = useMemo(() => history.filter((h) => h.chainId === chainId), [history, chainId]);

  const addressOptions = useMemo(
    () =>
      chainHistory
        .map((h) => ({
          value: h.address,
          label: (
            <Flex justify="space-between" gap={12}>
              <Text className="mono">{shortAddr(h.address, 10, 8)}</Text>
              <Text type="secondary">{h.tokenLabel}</Text>
            </Flex>
          ),
        }))
        .filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i),
    [chainHistory]
  );

  // 从历史中选择地址时，同时恢复当时查询的币种
  const onPickHistory = (address) => {
    const h = chainHistory.find((x) => x.address === address);
    if (!h || !chain) return;
    if (h.tokenKey?.startsWith('c:')) form.setFieldsValue({ token: CUSTOM, contract: h.tokenKey.slice(2) });
    else if (chain.tokens.some((t) => t.symbol === h.tokenKey)) form.setFieldsValue({ token: h.tokenKey });
  };

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

  // 新查询结果的默认小额阈值：约 1 美元（稳定币 = 1，无价格的代币不过滤）
  const defaultMinFor = (symbol) => amountForUsd(MIN_USD, prices[symbol]) ?? '';

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
    saveLast({ chainId: values.chainId, token: values.token, contract: values.token === CUSTOM ? req.token.contract : undefined });
    cancelLoadAll.current = true;
    const gen = ++queryGen.current;
    setLoading(true);
    setError('');
    updateResult(null);
    // 价格有缓存，顺便刷新一下
    api
      .getPrices()
      .then((p) => p?.prices && setPrices(p.prices))
      .catch(() => {});
    try {
      const res = await api.queryLedger(req);
      if (gen !== queryGen.current) return;
      const symbol = res.records[0]?.symbol || res.balanceSymbol || req.token.symbol || '';
      setMinAmount(defaultMinFor(symbol));
      updateResult({ ...res, req, symbol, records: withKeys(res.records) });
      pushHistory({
        chainId: req.chainId,
        address: req.address,
        tokenKey: req.token.symbol || `c:${req.token.contract}`,
        tokenLabel: req.token.symbol || symbol || shortAddr(req.token.contract),
      });
      setHistory(loadHistory());
      setLoading(false);
      if (rangeRef.current) ensureRange();
    } catch (e) {
      if (gen === queryGen.current) setError(e.message);
    } finally {
      if (gen === queryGen.current) setLoading(false);
    }
  };

  /**
   * 连续加载后续分页，直到 shouldContinue() 返回 false、没有更多数据、达到页数上限或被取消
   */
  const loadPages = async (shouldContinue, maxPages) => {
    const start = resultRef.current;
    if (!start?.nextCursor || loopRunning.current) return;
    const gen = queryGen.current;
    loopRunning.current = true;
    cancelLoadAll.current = false;
    setLoadingMore(true);
    let cursor = start.nextCursor;
    try {
      for (let i = 0; i < maxPages && cursor && shouldContinue(); i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 300)); // 避免触发频率限制
        if (cancelLoadAll.current || gen !== queryGen.current) break;
        const res = await api.queryLedger({ ...start.req, cursor });
        if (cancelLoadAll.current || gen !== queryGen.current) break;
        cursor = res.nextCursor;
        updateResult((prev) => ({ ...prev, records: [...prev.records, ...withKeys(res.records)], nextCursor: res.nextCursor }));
      }
    } catch (e) {
      if (gen === queryGen.current) message.error(`加载更多失败：${e.message}`);
    } finally {
      loopRunning.current = false;
      setLoadingMore(false);
    }
  };

  const loadMore = () => loadPages(() => true, 1);
  const loadAll = () => loadPages(() => true, LOAD_ALL_MAX_PAGES);

  // 选择时间区间后，自动加载更早的分页，直到覆盖区间起点
  const ensureRange = () =>
    loadPages(() => {
      const r = rangeRef.current;
      return !!r && oldestTime(resultRef.current?.records || []) >= r[0].valueOf();
    }, RANGE_AUTO_MAX_PAGES);

  const applyRange = (key, value) => {
    setRangeKey(key);
    setRange(value);
    rangeRef.current = value;
    if (value) ensureRange();
  };

  const onPreset = (key) => {
    if (key === 'all') applyRange('all', null);
    else if (key === 'custom') {
      setRangeKey('custom');
    } else applyRange(key, RANGE_PRESETS[key].get());
  };

  const onCustomRange = (v) => {
    if (!v || !v[0] || !v[1]) applyRange('custom', null);
    else applyRange('custom', [v[0].startOf('day'), v[1].endOf('day')]);
  };

  // ---- 筛选管线：时间 → 金额（用于统计和导出）→ 方向 / 关键字（只影响明细表）----
  const rangedRecords = useMemo(() => {
    if (!result) return [];
    if (!range) return result.records;
    const s0 = range[0].valueOf();
    const s1 = range[1].valueOf();
    return result.records.filter((r) => {
      const t = recTime(r);
      return t >= s0 && t <= s1;
    });
  }, [result, range]);

  const statRecords = useMemo(() => {
    if (!amountOn) return rangedRecords;
    const decimals = result?.records[0]?.decimals;
    const min = parseUnits(minAmount, decimals);
    if (!min) return rangedRecords;
    return rangedRecords.filter((r) => BigInt(r.value) >= min);
  }, [rangedRecords, amountOn, minAmount, result]);

  const tableRecords = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return statRecords
      .filter((r) => direction === 'all' || r.direction === direction)
      .filter(
        (r) =>
          !k ||
          r.hash.toLowerCase().includes(k) ||
          (r.from || '').toLowerCase().includes(k) ||
          (r.to || '').toLowerCase().includes(k)
      );
  }, [statRecords, direction, keyword]);

  // 区间起点早于已加载的最早记录，且还有更多数据 → 区间数据不完整
  const rangeIncomplete = !!range && !!result?.nextCursor && oldestTime(result.records) >= range[0].valueOf();

  const exportCsv = async () => {
    if (!tableRecords.length) return;
    const header = ['时间', '类型', '金额', '币种', '发送方', '接收方', '手续费', '手续费币种', '状态', '区块', '交易哈希', '浏览器链接'];
    const dirText = { in: '转入', out: '转出', self: '自转' };
    const statusText = { success: '成功', failed: '失败', pending: '待确认' };
    const rows = tableRecords.map((r) => [
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
    const sym = tableRecords[0].symbol;
    const span = range ? `_${range[0].format('YYYYMMDD')}-${range[1].format('YYYYMMDD')}` : '';
    const name = `${result.req.chainId}_${sym}_${result.req.address.slice(0, 10)}${span}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    try {
      const file = await api.exportCsv(name, [header, ...rows]);
      if (file) message.success(`已导出 ${rows.length} 条到 ${file}`);
    } catch (e) {
      message.error(e.message);
    }
  };

  const sum = useMemo(() => (result ? summarize(statRecords) : null), [result, statRecords]);
  const dec = result?.records[0]?.decimals ?? sum?.decimals ?? 0; // 筛选后可能为空，精度取自全部记录
  const sym = result?.symbol || sum?.symbol || result?.balanceSymbol || '';
  const price = prices[sym];
  const usdOf = (big, decimals) => {
    if (!price) return null;
    const v = Number(formatUnits(big, decimals)) * price;
    return `≈ $${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  };
  const filtered = !!range || (amountOn && parseUnits(minAmount, sum?.decimals) > 0n);
  const net = sum ? sum.inSum - sum.outSum : 0n;

  return (
    <Layout className="app-layout">
      <Header
        className="app-header"
        style={{ background: themeToken.colorBgContainer, borderBottom: `1px solid ${themeToken.colorBorderSecondary}` }}
      >
        <div className="app-title" style={{ color: themeToken.colorText }}>
          <WalletOutlined style={{ color: themeToken.colorPrimary }} />
          OnLedger
          <Text type="secondary" className="app-subtitle">
            链上地址账单查询
          </Text>
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
        <Card className="search-card">
          <Form form={form} layout="vertical" requiredMark={false} onFinish={runQuery}>
            <Row gutter={12} align="top">
              <Col xs={12} md={5} lg={4}>
                <Form.Item label="链" name="chainId" style={{ marginBottom: 0 }}>
                  <Select
                    size="large"
                    options={chains.map((c) => ({
                      value: c.id,
                      label: c.available === false ? `${c.name}（暂未开放）` : c.name,
                      disabled: c.available === false,
                    }))}
                    onChange={onChainChange}
                    loading={!chains.length}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4} lg={3}>
                <Form.Item label="币种" name="token" style={{ marginBottom: 0 }}>
                  <Select size="large" options={tokenOptions} />
                </Form.Item>
              </Col>
              {tokenValue === CUSTOM && (
                <Col xs={24} md={6} lg={5}>
                  <Form.Item
                    label="代币合约地址"
                    name="contract"
                    style={{ marginBottom: 0 }}
                    rules={[{ required: true, message: '请输入合约地址' }, addressRule('合约地址')]}
                  >
                    <Input size="large" className="mono" placeholder={chain?.type === 'tron' ? 'T...' : '0x...'} allowClear />
                  </Form.Item>
                </Col>
              )}
              <Col xs={24} md={tokenValue === CUSTOM ? 6 : 12} flex="auto">
                <Form.Item
                  label="地址"
                  name="address"
                  style={{ marginBottom: 0 }}
                  rules={[{ required: true, message: '请输入要查询的地址' }, addressRule('地址')]}
                >
                  <AutoComplete
                    options={addressOptions}
                    open={historyOpen && addressOptions.length > 0}
                    onOpenChange={setHistoryOpen}
                    onSelect={onPickHistory}
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
                      size="large"
                      className="mono"
                      allowClear
                      placeholder={
                        chain?.type === 'evm' ? '输入 0x 开头的地址' : chain?.type === 'tron' ? '输入 T 开头的地址' : '输入 bc1 / 1 / 3 开头的地址'
                      }
                      onKeyDown={(e) => {
                        // AutoComplete 会吞掉回车：回车总是直接查询（若高亮了历史项，先让它填入再查询）
                        if (e.key === 'Enter') {
                          setHistoryOpen(false);
                          setTimeout(() => form.submit(), 0);
                        }
                      }}
                    />
                  </AutoComplete>
                </Form.Item>
              </Col>
              <Col xs={24} md={3}>
                <Form.Item label=" " colon={false} style={{ marginBottom: 0 }}>
                  <Button size="large" type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading} block>
                    查询
                  </Button>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>

        {error && (
          <Alert
            type="error"
            showIcon
            title="查询失败"
            description={error}
            action={
              <Button size="small" icon={<ReloadOutlined />} onClick={runQuery}>
                重试
              </Button>
            }
            closable={{ onClose: () => setError('') }}
          />
        )}

        {result && (
          <FilterPanel
            rangeKey={rangeKey}
            range={range}
            onPreset={onPreset}
            onCustomRange={onCustomRange}
            rangeLoading={loadingMore}
            rangeIncomplete={rangeIncomplete}
            onContinueRange={ensureRange}
            amountOn={amountOn}
            onAmountOn={setAmountOn}
            minAmount={minAmount}
            onMinAmount={setMinAmount}
            symbol={sym}
            price={price}
            hiddenCount={rangedRecords.length - statRecords.length}
            direction={direction}
            onDirection={setDirection}
            keyword={keyword}
            onKeyword={setKeyword}
          />
        )}

        {result && (
          <Row gutter={[16, 16]}>
            <Col xs={12} lg={6}>
              <Card size="small" className="stat-card">
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
                <Text type="secondary" className="stat-sub">
                  {result.balance != null ? usdOf(parseUnits(result.balance, dec) ?? 0n, dec) : ''}
                </Text>
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small" className="stat-card">
                <Statistic
                  title={`${filtered ? '筛选后' : ''}转入（${sum.inCount} 笔）`}
                  value={prettyAmount(formatUnits(sum.inSum, dec))}
                  suffix={sym}
                  styles={{ content: { color: '#389e0d' } }}
                />
                <Text type="secondary" className="stat-sub">
                  {usdOf(sum.inSum, dec)}
                </Text>
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small" className="stat-card">
                <Statistic
                  title={`${filtered ? '筛选后' : ''}转出（${sum.outCount} 笔）`}
                  value={prettyAmount(formatUnits(sum.outSum, dec))}
                  suffix={sym}
                  styles={{ content: { color: '#cf1322' } }}
                />
                <Text type="secondary" className="stat-sub">
                  {usdOf(sum.outSum, dec)}
                </Text>
              </Card>
            </Col>
            <Col xs={12} lg={6}>
              <Card size="small" className="stat-card">
                <Statistic
                  title="净流入"
                  value={prettyAmount(formatUnits(net, dec))}
                  suffix={sym}
                  styles={{ content: { color: net < 0n ? '#cf1322' : net > 0n ? '#389e0d' : undefined } }}
                />
                <Text type="secondary" className="stat-sub">
                  手续费 {sum.feeSum ? `${formatUnits(sum.feeSum, sum.feeDecimals)} ${sum.feeSymbol}` : '-'}
                </Text>
              </Card>
            </Col>
          </Row>
        )}

        <Card
          size="small"
          title={
            <Flex gap={8} align="center">
              账单明细
              {result && (
                <Tag>
                  {tableRecords.length} / 已加载 {result.records.length} 条
                </Tag>
              )}
              {result && (
                <Text type="secondary" style={{ fontWeight: 'normal', fontSize: 12 }}>
                  {result.nextCursor ? '还有更早的记录未加载' : '已加载全部记录'}
                </Text>
              )}
            </Flex>
          }
          extra={
            <Flex gap={8}>
              {result?.nextCursor &&
                (loadingMore ? (
                  <Button onClick={() => (cancelLoadAll.current = true)}>停止加载</Button>
                ) : (
                  <Button onClick={loadAll}>加载全部</Button>
                ))}
              <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!tableRecords.length}>
                导出 CSV
              </Button>
            </Flex>
          }
        >
          {result || loading ? (
            <LedgerTable
              records={tableRecords}
              loading={loading}
              emptyText={
                result && result.records.length > 0 && tableRecords.length === 0 ? (
                  <Flex vertical gap={8} align="center">
                    <Text type="secondary">已加载的 {result.records.length} 条记录都被筛选条件过滤了</Text>
                    <Flex gap={8}>
                      {amountOn && (
                        <Button size="small" onClick={() => setAmountOn(false)}>
                          显示小额交易
                        </Button>
                      )}
                      {result.nextCursor && (
                        <Button size="small" onClick={loadMore} loading={loadingMore}>
                          加载更早的记录
                        </Button>
                      )}
                    </Flex>
                  </Flex>
                ) : undefined
              }
              footer={
                result?.nextCursor
                  ? () => (
                      <Flex justify="center">
                        <Button onClick={loadMore} loading={loadingMore}>
                          加载更多
                        </Button>
                      </Flex>
                    )
                  : undefined
              }
            />
          ) : (
            <Empty
              description={
                <Flex vertical gap={8} align="center">
                  <Text type="secondary">选择链和币种，输入地址后点击查询</Text>
                  <Flex gap={4} wrap justify="center">
                    {chains.map((c) => (
                      <Tag key={c.id} color={c.available === false ? undefined : 'blue'}>
                        {c.name}
                      </Tag>
                    ))}
                  </Flex>
                </Flex>
              }
            />
          )}
        </Card>
      </Content>

      {api.isDesktop && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </Layout>
  );
}

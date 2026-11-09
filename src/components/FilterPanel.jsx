import React from 'react';
import { Card, Flex, Segmented, DatePicker, Switch, Input, InputNumber, Typography, Button, Tooltip } from 'antd';
import { CalendarOutlined, DollarOutlined, SwapOutlined, SearchOutlined, InfoCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Text } = Typography;

export const RANGE_PRESETS = {
  day: { label: '今天', get: () => [dayjs().startOf('day'), dayjs().endOf('day')] },
  week: { label: '近一周', get: () => [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')] },
  month: { label: '近一月', get: () => [dayjs().subtract(1, 'month').startOf('day'), dayjs().endOf('day')] },
  quarter: { label: '近三个月', get: () => [dayjs().subtract(3, 'month').startOf('day'), dayjs().endOf('day')] },
};

function Row({ icon, label, children }) {
  return (
    <Flex gap={12} align="center" wrap className="filter-row">
      <Text className="filter-label" type="secondary">
        {icon} {label}
      </Text>
      <Flex gap={8} align="center" wrap style={{ flex: 1 }}>
        {children}
      </Flex>
    </Flex>
  );
}

/**
 * 筛选面板：时间 / 金额 / 方向 / 关键字
 * 统计基于「时间 + 金额」筛选；方向和关键字只影响明细表
 */
export default function FilterPanel({
  rangeKey,
  range,
  onPreset,
  onCustomRange,
  rangeLoading,
  rangeIncomplete,
  onContinueRange,
  amountOn,
  onAmountOn,
  minAmount,
  onMinAmount,
  symbol,
  price,
  hiddenCount,
  direction,
  onDirection,
  keyword,
  onKeyword,
}) {
  const usd = price && minAmount && Number(minAmount) > 0 ? Number(minAmount) * price : null;

  return (
    <Card size="small" title="筛选" className="filter-card">
      <Flex vertical gap={12}>
        <Row icon={<CalendarOutlined />} label="时间">
          <Segmented
            value={rangeKey}
            onChange={onPreset}
            options={[
              { label: '全部', value: 'all' },
              ...Object.entries(RANGE_PRESETS).map(([value, p]) => ({ label: p.label, value })),
              { label: '自定义', value: 'custom' },
            ]}
          />
          {rangeKey === 'custom' && (
            <DatePicker.RangePicker
              value={range}
              onChange={onCustomRange}
              allowClear
              disabledDate={(d) => d.isAfter(dayjs().endOf('day'))}
              placeholder={['开始日期', '结束日期']}
            />
          )}
          {range && rangeKey !== 'custom' && (
            <Text type="secondary">
              {range[0].format('YYYY-MM-DD')} ~ {range[1].format('YYYY-MM-DD')}
            </Text>
          )}
          {range && rangeLoading && <Text type="secondary">正在加载区间内的记录…</Text>}
          {rangeIncomplete && !rangeLoading && (
            <>
              <Text type="warning">区间内数据未完整加载，统计可能偏少</Text>
              <Button size="small" onClick={onContinueRange}>
                继续加载
              </Button>
            </>
          )}
        </Row>

        <Row icon={<DollarOutlined />} label="金额">
          <Switch checked={amountOn} onChange={onAmountOn} checkedChildren="过滤小额" unCheckedChildren="不过滤" />
          {amountOn && (
            <>
              <Text>小于</Text>
              <InputNumber
                stringMode
                min="0"
                value={minAmount}
                onChange={(v) => onMinAmount(v ?? '')}
                style={{ width: 180 }}
                suffix={symbol || undefined}
                placeholder="最小金额"
              />
              <Text type="secondary">{usd != null ? `≈ $${usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(2)}` : ''}</Text>
              <Text type="secondary">的交易不显示、不统计</Text>
              {hiddenCount > 0 && <Text type="secondary">（已隐藏 {hiddenCount} 笔）</Text>}
              {!price && symbol && (
                <Tooltip title="该代币没有价格数据，请手动填写最小金额">
                  <InfoCircleOutlined />
                </Tooltip>
              )}
            </>
          )}
        </Row>

        <Row icon={<SwapOutlined />} label="明细">
          <Segmented
            value={direction}
            onChange={onDirection}
            options={[
              { label: '全部', value: 'all' },
              { label: '转入', value: 'in' },
              { label: '转出', value: 'out' },
            ]}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="按交易哈希 / 地址筛选"
            style={{ width: 320 }}
            value={keyword}
            onChange={(e) => onKeyword(e.target.value)}
          />
        </Row>
      </Flex>
    </Card>
  );
}

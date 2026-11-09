import React from 'react';
import { Table, Tag, Typography, Tooltip, Flex } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { formatUnits, prettyAmount } from '../utils';
import { api } from '../api';

const { Text, Link } = Typography;

const DIR = {
  in: { color: 'green', text: '转入' },
  out: { color: 'red', text: '转出' },
  self: { color: 'default', text: '自转' },
};

const STATUS = {
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  pending: { color: 'processing', text: '待确认' },
};

function Addr({ value }) {
  if (!value) return <Text type="secondary">-</Text>;
  return (
    <Text className="mono nowrap" copyable={{ text: value.split(' ')[0] }}>
      {value}
    </Text>
  );
}

const cmpBig = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x > y ? 1 : -1;
};

export default function LedgerTable({ records, loading, footer, emptyText }) {
  const columns = [
    {
      title: '对方地址',
      key: 'counterparty',
      fixed: 'left',
      render: (_, r) => <Addr value={r.direction === 'in' ? r.from : r.to} />,
    },
    {
      title: '时间',
      dataIndex: 'time',
      sorter: (a, b) => (a.time || 0) - (b.time || 0),
      render: (t) => (
        <span className="nowrap">{t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : <Text type="secondary">未确认</Text>}</span>
      ),
    },
    {
      title: '类型',
      dataIndex: 'direction',
      render: (d) => <Tag color={DIR[d]?.color}>{DIR[d]?.text || d}</Tag>,
    },
    {
      title: '金额',
      dataIndex: 'value',
      align: 'right',
      sorter: (a, b) => cmpBig(a.value, b.value),
      render: (v, r) => {
        const sign = r.direction === 'in' ? '+' : r.direction === 'out' ? '-' : '';
        const cls = r.direction === 'in' ? 'amount-in' : r.direction === 'out' ? 'amount-out' : '';
        return (
          <Text className={`mono nowrap ${cls}`} delete={r.status === 'failed'}>
            {sign}
            {prettyAmount(formatUnits(v, r.decimals))} {r.symbol}
          </Text>
        );
      },
    },
    {
      title: '手续费',
      dataIndex: 'fee',
      align: 'right',
      render: (f, r) =>
        f && f !== '0' ? (
          <Text className="mono nowrap" type="secondary">
            {formatUnits(f, r.feeDecimals)} {r.feeSymbol}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.text || s}</Tag>,
    },
    {
      title: '交易哈希',
      dataIndex: 'hash',
      render: (h, r) => (
        <Flex gap={6} align="center" className="nowrap">
          <Text className="mono" copyable={{ text: h }}>
            {h}
          </Text>
          <Tooltip title="在区块浏览器中查看">
            <Link onClick={() => api.openExternal(r.explorerUrl)}>
              <ExportOutlined />
            </Link>
          </Tooltip>
        </Flex>
      ),
    },
  ];

  return (
    <Table
      rowKey="_key"
      size="middle"
      columns={columns}
      dataSource={records}
      loading={loading}
      scroll={{ x: 'max-content' }}
      pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (t) => `共 ${t} 条` }}
      footer={footer}
      locale={emptyText ? { emptyText } : undefined}
    />
  );
}

"""Create synthetic, local-only fixtures for Debug UI verification; never read real data."""
import copy
import json
import pathlib
import sys

output = pathlib.Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
source = pathlib.Path(__file__).resolve().parents[1] / 'Tests/BuffReaderCoreTests/Fixtures'
data = {p.stem: json.loads(p.read_text()) for p in source.glob('*.json')}
profile = data['profiles']['result']['profiles'][0]
profile.update(name='账户一 · 示例', recordCount=1286, collectedAt='2026-10-28T06:20:00Z', uploadedAt='2026-10-28T06:22:00Z')
profile['bindings'] = {'buff': '演示 BUFF 账号', 'uu': '演示悠悠账号', 'steam': '演示 Steam 账号'}
profile['status'] = {'platforms': {p: {'phase': 'completed'} for p in ['buff', 'uu', 'steam']}}
data['profiles']['result']['profiles'][1]['name'] = '账户二 · 示例'
overview = data['overview']['result']
overview['profile'] = copy.deepcopy(profile)
overview['currencies'][0].update(profitCents=128643, knownProfitCents=128643, cashInvestmentCents=6289000, knownCashInvestmentCents=6289000, holdingQuantity=146)
overview['sourceStatus'] = {p: {'lastSyncedAt': '2026-10-28T06:20:00Z', 'recordCount': count} for p, count in [('buff', 562), ('uu', 328), ('steam', 396)]}
data['sync-status']['result'].update(uploadedAt=profile['uploadedAt'], collectedAt=profile['collectedAt'], sourceStatus=overview['sourceStatus'], status=profile['status'])
names = ['AK-47 | 红线（久经沙场）', 'M4A1 消音型 | 印花集（略有磨损）', 'AWP | 二西莫夫（久经沙场）']
orders = data['orders']['result']
sample = orders['rows'][0]
orders['rows'] = []
for i, (name, amount, platform) in enumerate(zip(names, [68500, 152835, 89600], ['buff', 'uu', 'steam'])):
    row = copy.deepcopy(sample)
    row.update(id=f'preview-order-{i}', orderId=f'示例-{i + 1}', name=name, marketHashName=name, actualTotalCents=amount, platform=platform, direction='sell' if i == 1 else 'buy', tradedAt=f'2026-10-{28-i}T06:08:00Z', completed=True, quantity=1)
    orders['rows'].append(row)
orders.update(total=3, page=1, pageSize=30)
holdings = data['holdings']['result']
sample = holdings['rows'][0]
holdings['rows'] = []
for i, (name, count) in enumerate(zip(names, [12, 8, 126])):
    row = copy.deepcopy(sample)
    row.update(id=f'preview-holding-{i}', name=name, quantity=count, cashQuantity=count if i != 1 else 0, cashCostCents=68500*count if i != 1 else None, steamQuantity=count if i == 1 else 0, steamFaceCents=182400*count if i == 1 else 0, currencyCode='CNY')
    holdings['rows'].append(row)
holdings.update(total=3, page=1, pageSize=30)
report = data['report']['result']
report['summary'].update(profitCents=128643, knownProfitCents=128643, cashInvestmentCents=6289000, knownCashInvestmentCents=6289000)
report['daily'] = []
cumulative = 0
for i, profit in enumerate([12000, 18200, -3600, 25400, 40200, 36443]):
    cumulative += profit
    report['daily'].append({'date': f'2026-10-{23+i}', 'profitCents': profit, 'knownProfitCents': profit, 'cumulativeProfitCents': cumulative, 'cumulativePending': 0})
alchemy = data['alchemy']['result']
row = alchemy['rows'][0]
row['output'].update(name='M4A1 消音型 | 印花集（略有磨损）', marketHashName='M4A1-S | Printstream (Minimal Wear)')
row['inputs'][0].update(name='P250 | 富兰克林（略有磨损）', marketHashName='P250 | Franklin (Minimal Wear)')
row['cost'].update(cash=38520, steam=0, basis=38520)
row['inputs'][0]['cost'] = copy.deepcopy(row['cost'])
row['inputs'][0]['sources'][0]['totalCents'] = 38520
row['cashProfitCents'] = 12680
row['sale']['netCents'] = 51200
alchemy['summary']['currencies'][0]['cashProfitCents'] = 12680
for key, value in data.items():
    (output / f'{key}.json').write_text(json.dumps(value, ensure_ascii=False))
print(f'Synthetic preview fixtures: {output}')

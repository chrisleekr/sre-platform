const DISPLAY_USD = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const EXACT_USD = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function Money({ amount, className }: { amount: number; className?: string }) {
  return (
    <data
      value={amount}
      title={`Exact configured value: ${EXACT_USD.format(amount)}`}
      className={className}
    >
      {DISPLAY_USD.format(amount)}
    </data>
  );
}

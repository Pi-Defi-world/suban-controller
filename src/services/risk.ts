/**
 * Deterministic lending-risk calculations.
 *
 * The formulas are shared by the API and tests. They use only supplied prices
 * and amounts; this module never fetches a price or invents a fallback.
 *
 * Method: `lending_risk_v1`
 * - collateral_value = sum(collateral amount * price)
 * - debt_value = sum(debt amount * price)
 * - health_factor = collateral_value * liquidation_threshold / debt_value
 * - max_borrow = collateral_value * liquidation_threshold / target_health_factor
 * - liquidation_price (single collateral asset) =
 *     debt_value / (collateral_amount * liquidation_threshold)
 */
export const RISK_METHOD_VERSION = 'lending_risk_v1';
export const DEFAULT_LIQUIDATION_THRESHOLD = 0.8;
export const DEFAULT_TARGET_HEALTH_FACTOR = 1.5;

export interface PricedRiskPosition {
  asset: string;
  amount: number;
  price_usd: number;
}

export interface LendingRiskInput {
  collateral: PricedRiskPosition[];
  debt: PricedRiskPosition[];
  liquidation_threshold?: number;
  target_health_factor?: number;
}

export type RiskStatus = 'no_debt' | 'healthy' | 'at_risk' | 'liquidatable';

export interface LendingRiskResult {
  method_version: string;
  status: RiskStatus;
  health_factor: number | null;
  collateral_value_usd: number;
  debt_value_usd: number;
  liquidation_threshold: number;
  target_health_factor: number;
  max_borrow_usd: number;
  liquidation_price_usd_per_collateral_unit: number | null;
  liquidation_price_asset: string | null;
  warnings: string[];
}

export class RiskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskInputError';
  }
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RiskInputError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function validatePositions(
  positions: PricedRiskPosition[],
  field: string
): PricedRiskPosition[] {
  if (!Array.isArray(positions)) {
    throw new RiskInputError(`${field} must be an array`);
  }
  return positions.map((position, index) => {
    if (!position || typeof position.asset !== 'string' || position.asset.length === 0) {
      throw new RiskInputError(`${field}[${index}].asset is required`);
    }
    const amount = finiteNonNegative(position.amount, `${field}[${index}].amount`);
    const price = finiteNonNegative(position.price_usd, `${field}[${index}].price_usd`);
    if (price === 0) {
      throw new RiskInputError(`${field}[${index}].price_usd must be greater than zero`);
    }
    return {
      asset: position.asset.toUpperCase(),
      amount,
      price_usd: price,
    };
  });
}

export function computeLendingRisk(input: LendingRiskInput): LendingRiskResult {
  const collateral = validatePositions(input.collateral, 'collateral');
  const debt = validatePositions(input.debt, 'debt');

  const liquidationThreshold =
    input.liquidation_threshold ?? DEFAULT_LIQUIDATION_THRESHOLD;
  if (
    typeof liquidationThreshold !== 'number' ||
    !Number.isFinite(liquidationThreshold) ||
    liquidationThreshold <= 0 ||
    liquidationThreshold > 1
  ) {
    throw new RiskInputError('liquidation_threshold must be greater than 0 and at most 1');
  }

  const targetHealthFactor =
    input.target_health_factor ?? DEFAULT_TARGET_HEALTH_FACTOR;
  if (
    typeof targetHealthFactor !== 'number' ||
    !Number.isFinite(targetHealthFactor) ||
    targetHealthFactor < 1
  ) {
    throw new RiskInputError('target_health_factor must be at least 1');
  }

  const collateralValue = collateral.reduce(
    (sum, position) => sum + position.amount * position.price_usd,
    0
  );
  const debtValue = debt.reduce(
    (sum, position) => sum + position.amount * position.price_usd,
    0
  );

  const warnings: string[] = [];
  let healthFactor: number | null = null;
  let status: RiskStatus;

  if (debtValue === 0) {
    status = 'no_debt';
  } else if (collateralValue === 0) {
    healthFactor = 0;
    status = 'liquidatable';
  } else {
    healthFactor = (collateralValue * liquidationThreshold) / debtValue;
    if (healthFactor < 1) {
      status = 'liquidatable';
    } else if (healthFactor < targetHealthFactor) {
      status = 'at_risk';
    } else {
      status = 'healthy';
    }
  }

  const maxBorrow =
    (collateralValue * liquidationThreshold) / targetHealthFactor;

  let liquidationPrice: number | null = null;
  let liquidationPriceAsset: string | null = null;
  if (collateral.length === 1) {
    const position = collateral[0];
    liquidationPriceAsset = position.asset;
    if (position.amount > 0 && debtValue > 0) {
      liquidationPrice =
        debtValue / (position.amount * liquidationThreshold);
    }
  } else if (collateral.length > 1) {
    warnings.push(
      'liquidation price is undefined for a multi-collateral basket; use health_factor'
    );
  }

  if (debt.length > 1) {
    warnings.push(
      'liquidation price assumes debt value is fixed; multiple debt assets make it approximate'
    );
  }

  return {
    method_version: RISK_METHOD_VERSION,
    status,
    health_factor: healthFactor,
    collateral_value_usd: collateralValue,
    debt_value_usd: debtValue,
    liquidation_threshold: liquidationThreshold,
    target_health_factor: targetHealthFactor,
    max_borrow_usd: maxBorrow,
    liquidation_price_usd_per_collateral_unit: liquidationPrice,
    liquidation_price_asset: liquidationPriceAsset,
    warnings,
  };
}

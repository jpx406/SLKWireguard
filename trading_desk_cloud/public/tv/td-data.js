/* ============================================================================
 * td-data.js — Trading Desk data layer for Screeners + Yield Curves
 * ----------------------------------------------------------------------------
 * Reverse-engineered from TradingView's screener products (16 Nov 2026):
 *
 *   POST https://scanner.tradingview.com/<market>/scan?label-product=<tag>
 *   body (text/plain or application/json):
 *   {
 *     columns:  [ "field", ... ],                      // what to return, in order
 *     filter:   [ {left, operation, right}, ... ],    // simple AND filters
 *     filter2:  { operator:"and"|"or", operands:[ {expression:{left,operation,right}} | {operation:{...}} ] },
 *     sort:     { sortBy:"field", sortOrder:"asc"|"desc" },
 *     range:    [from, to],                            // pagination (0-based, exclusive end)
 *     markets:  [ "america", ... ],                    // for stock/etf; omitted for bond/coin/forex
 *     symbols:  { tickers:["NASDAQ:AAPL", ...] },      // explicit symbol list (used for yield curves)
 *     index_filters: [{name, values}],                 // bond: e.g. bond_issuer_cr_parent_stock_symbol
 *     preset:   "stocks_related_bonds",                // bond presets
 *     options:  { lang:"en" },
 *     ignore_unknown_fields: false
 *   }
 *   response: { totalCount:N, data:[ { s:"EXCHANGE:SYM", d:[ ...values in column order ] } ] }
 *
 *   Operations seen: equal, nequal, greater, egreater, less, eless, in_range, not_in_range,
 *                    has, has_none_of, empty, nempty, match, in_day_range
 *   ".tr" suffix on a field returns the translated/display string (e.g. "sector.tr").
 *
 * Market paths: america (stocks + ETFs), bond, coin (crypto coins), forex, cfd,
 *               global, plus country codes (uk, germany, japan, ksa, ...).
 *
 * Data sources (in order):
 *   1. TradingView scanner, direct from the browser
 *   2. TradingView scanner via your own proxy  (TD_CONFIG.proxyBase + '/tv/<market>/scan')
 *   3. Official sources via proxy (US Treasury, FRED) — yield curves only
 *   4. Last good snapshot cached in localStorage (stale, flagged)
 * ========================================================================== */
(function (global) {
  'use strict';

  const TD_CONFIG = Object.assign({
    scannerBase: 'https://scanner.tradingview.com',
    proxyBase: '/api',              // your backend: see proxy/server.js
    label: 'trading-desk',
    cacheTTL: 60 * 1000,            // ms for in-memory cache of scanner replies
    timeoutMs: 12000,
    lang: 'en',
  }, global.TD_CONFIG || {});

  /* ---------------------------------------------------------------------------
   * Column catalogue: label, format, alignment, description.
   * Field names are TradingView scanner fields (captured from the live product).
   * ------------------------------------------------------------------------ */
  const F = {
    // identity
    'name':               { label: 'Symbol',        fmt: 'sym' },
    'description':        { label: 'Name',          fmt: 'text' },
    'logoid':             { label: 'Logo',          fmt: 'hidden' },
    'exchange':           { label: 'Exchange',      fmt: 'text' },
    'currency':           { label: 'Ccy',           fmt: 'text' },
    'fundamental_currency_code': { label: 'Fund ccy', fmt: 'hidden' },
    'type':               { label: 'Type',          fmt: 'hidden' },
    'typespecs':          { label: 'Type specs',    fmt: 'hidden' },
    'update_mode':        { label: 'Feed',          fmt: 'hidden' },
    'pricescale':         { fmt: 'hidden' }, 'minmov': { fmt: 'hidden' }, 'fractional': { fmt: 'hidden' }, 'minmove2': { fmt: 'hidden' },
    'market':             { label: 'Market',        fmt: 'hidden' },
    // price / volume
    'close':              { label: 'Price',         fmt: 'price' },
    'change':             { label: 'Chg %',         fmt: 'pct', signed: true },
    'change_abs':         { label: 'Chg',           fmt: 'num', signed: true },
    'volume':             { label: 'Vol',           fmt: 'big' },
    'Value.Traded':       { label: 'Value traded',  fmt: 'big' },
    'relative_volume_10d_calc': { label: 'Rel vol', fmt: 'num2' },
    'average_volume_30d_calc':  { label: 'Avg vol 30d', fmt: 'big' },
    'market_cap_basic':   { label: 'Mkt cap',       fmt: 'big' },
    'beta_1_year':        { label: 'Beta',          fmt: 'num2' },
    'price_52_week_high': { label: '52W high',      fmt: 'price' },
    'price_52_week_low':  { label: '52W low',       fmt: 'price' },
    // fundamentals
    'price_earnings_ttm': { label: 'P/E',           fmt: 'num2' },
    'earnings_per_share_diluted_ttm': { label: 'EPS dil TTM', fmt: 'num2' },
    'earnings_per_share_diluted_yoy_growth_ttm': { label: 'EPS growth YoY', fmt: 'pct', signed: true },
    'dividends_yield_current': { label: 'Div yield %', fmt: 'pct' },
    'dividends_yield':    { label: 'Div yield TTM', fmt: 'pct' },
    'sector.tr':          { label: 'Sector',        fmt: 'text' },
    'sector':             { label: 'Group',         fmt: 'text' },
    'Recommend.All':      { label: 'Tech score',    fmt: 'num2' },
    'industry.tr':        { label: 'Industry',      fmt: 'text' },
    'AnalystRating':      { label: 'Analyst rating', fmt: 'rating' },
    'AnalystRating.tr':   { label: 'Analyst rating', fmt: 'hidden' },
    'total_revenue_yoy_growth_ttm': { label: 'Revenue growth', fmt: 'pct', signed: true },
    'price_earnings_growth_ttm': { label: 'PEG',   fmt: 'num2' },
    'return_on_equity':   { label: 'ROE %',        fmt: 'pct' },
    'return_on_assets':   { label: 'ROA %',        fmt: 'pct' },
    'gross_margin':       { label: 'Gross margin', fmt: 'pct' },
    'operating_margin':   { label: 'Op margin',    fmt: 'pct' },
    'net_margin':         { label: 'Net margin',   fmt: 'pct' },
    'earnings_release_date': { label: 'Recent earnings', fmt: 'date' },
    'earnings_release_next_date': { label: 'Next earnings', fmt: 'date' },
    // performance
    'Perf.W': { label: '1W %', fmt: 'pct', signed: true }, 'Perf.1M': { label: '1M %', fmt: 'pct', signed: true },
    'Perf.3M': { label: '3M %', fmt: 'pct', signed: true }, 'Perf.6M': { label: '6M %', fmt: 'pct', signed: true },
    'Perf.YTD': { label: 'YTD %', fmt: 'pct', signed: true }, 'Perf.Y': { label: '1Y %', fmt: 'pct', signed: true },
    'Perf.5Y': { label: '5Y %', fmt: 'pct', signed: true }, 'Perf.10Y': { label: '10Y %', fmt: 'pct', signed: true },
    'Perf.All': { label: 'All %', fmt: 'pct', signed: true },
    'Volatility.W': { label: 'Vol 1W', fmt: 'pct' }, 'Volatility.M': { label: 'Vol 1M', fmt: 'pct' },
    'Perf.1Y.MarketCap': { label: 'Mkt cap perf 1Y', fmt: 'pct', signed: true },
    // technicals
    'TechRating_1D': { label: 'Tech rating', fmt: 'techrating' }, 'TechRating_1D.tr': { fmt: 'hidden' },
    'MARating_1D':   { label: 'MA rating',   fmt: 'techrating' }, 'MARating_1D.tr': { fmt: 'hidden' },
    'OsRating_1D':   { label: 'Osc rating',  fmt: 'techrating' }, 'OsRating_1D.tr': { fmt: 'hidden' },
    'RSI': { label: 'RSI 14', fmt: 'num2' }, 'Mom': { label: 'Momentum', fmt: 'num2' }, 'AO': { label: 'AO', fmt: 'num2' },
    'CCI20': { label: 'CCI 20', fmt: 'num2' }, 'Stoch.K': { label: 'Stoch %K', fmt: 'num2' }, 'Stoch.D': { label: 'Stoch %D', fmt: 'num2' },
    'MACD.macd': { label: 'MACD', fmt: 'num2' }, 'MACD.signal': { label: 'MACD sig', fmt: 'num2' },
    'ADX': { label: 'ADX', fmt: 'num2' }, 'ATR': { label: 'ATR', fmt: 'num2' },
    'SMA20': { label: 'SMA 20', fmt: 'price' }, 'SMA50': { label: 'SMA 50', fmt: 'price' }, 'SMA200': { label: 'SMA 200', fmt: 'price' },
    'EMA20': { label: 'EMA 20', fmt: 'price' }, 'EMA50': { label: 'EMA 50', fmt: 'price' }, 'EMA200': { label: 'EMA 200', fmt: 'price' },
    'candlestick_patterns_1D': { label: 'Candle pattern', fmt: 'text' },
    // valuation
    'price_sales_current': { label: 'P/S', fmt: 'num2' }, 'price_book_fq': { label: 'P/B', fmt: 'num2' },
    'price_to_cash_f_operating_activities_ttm': { label: 'P/CF', fmt: 'num2' },
    'price_free_cash_flow_ttm': { label: 'P/FCF', fmt: 'num2' }, 'price_to_cash_ratio': { label: 'P/Cash', fmt: 'num2' },
    'enterprise_value_current': { label: 'EV', fmt: 'big' }, 'enterprise_value_to_revenue_ttm': { label: 'EV/Rev', fmt: 'num2' },
    'enterprise_value_to_ebit_ttm': { label: 'EV/EBIT', fmt: 'num2' }, 'enterprise_value_ebitda_ttm': { label: 'EV/EBITDA', fmt: 'num2' },
    // dividends
    'dps_common_stock_prim_issue_fy': { label: 'DPS FY', fmt: 'num2' }, 'dps_common_stock_prim_issue_fq': { label: 'DPS FQ', fmt: 'num2' },
    'dividend_payout_ratio_ttm': { label: 'Payout %', fmt: 'pct' },
    'dps_common_stock_prim_issue_yoy_growth_fy': { label: 'DPS growth', fmt: 'pct', signed: true },
    'continuous_dividend_payout': { label: 'Yrs paid', fmt: 'int' }, 'continuous_dividend_growth': { label: 'Yrs grown', fmt: 'int' },
    'indicated_annual_dividend': { label: 'Indicated div', fmt: 'num2' },
    'dividends_frequency.tr': { label: 'Frequency', fmt: 'text' }, 'dividend_treatment.tr': { label: 'Treatment', fmt: 'text' },
    // ETF
    'aum': { label: 'AUM', fmt: 'big' }, 'expense_ratio': { label: 'Expense %', fmt: 'pct' },
    'etf_holdings_count': { label: 'Holdings', fmt: 'int' }, 'nav': { label: 'NAV', fmt: 'price' },
    'nav_discount_premium': { label: 'Prem/Disc %', fmt: 'pct', signed: true },
    'nav_total_return.1M': { label: 'NAV TR 1M', fmt: 'pct', signed: true }, 'nav_total_return.3M': { label: 'NAV TR 3M', fmt: 'pct', signed: true },
    'nav_total_return.1Y': { label: 'NAV TR 1Y', fmt: 'pct', signed: true }, 'nav_total_return.3Y': { label: 'NAV TR 3Y', fmt: 'pct', signed: true },
    'nav_total_return.YTD': { label: 'NAV TR YTD', fmt: 'pct', signed: true },
    'nav_perf.1M': { label: 'NAV 1M', fmt: 'pct', signed: true }, 'nav_perf.3M': { label: 'NAV 3M', fmt: 'pct', signed: true },
    'nav_perf.1Y': { label: 'NAV 1Y', fmt: 'pct', signed: true }, 'nav_perf.3Y': { label: 'NAV 3Y', fmt: 'pct', signed: true }, 'nav_perf.YTD': { label: 'NAV YTD', fmt: 'pct', signed: true },
    'fund_flows.1M': { label: 'Flows 1M', fmt: 'big', signed: true }, 'fund_flows.3M': { label: 'Flows 3M', fmt: 'big', signed: true },
    'fund_flows.1Y': { label: 'Flows 1Y', fmt: 'big', signed: true }, 'fund_flows.3Y': { label: 'Flows 3Y', fmt: 'big', signed: true }, 'fund_flows.YTD': { label: 'Flows YTD', fmt: 'big', signed: true },
    'asset_class.tr': { label: 'Asset class', fmt: 'text' }, 'focus.tr': { label: 'Focus', fmt: 'text' },
    'category.tr': { label: 'Category', fmt: 'text' }, 'brand.tr': { label: 'Brand', fmt: 'text' },
    'launch_date': { label: 'Launched', fmt: 'date' },
    // crypto
    'crypto_total_rank': { label: 'Rank', fmt: 'int' }, 'market_cap_calc': { label: 'Mkt cap', fmt: 'big' },
    'market_cap_diluted_calc': { label: 'FD mkt cap', fmt: 'big' }, '24h_vol_cmc': { label: '24h vol', fmt: 'big' },
    '24h_vol_to_market_cap': { label: 'Vol/Mcap', fmt: 'num2' }, 'circulating_supply': { label: 'Circ supply', fmt: 'big' },
    'total_supply': { label: 'Total supply', fmt: 'big' }, 'max_supply': { label: 'Max supply', fmt: 'big' },
    'crypto_common_categories.tr': { label: 'Categories', fmt: 'text' }, 'base_currency_desc': { label: 'Name', fmt: 'text' },
    'base_currency_logoid': { fmt: 'hidden' }, 'crypto_blockchain_ecosystems.tr': { label: 'Ecosystem', fmt: 'text' },
    'socialdominance': { label: 'Social dom %', fmt: 'pct' }, 'galaxyscore': { label: 'Galaxy score', fmt: 'int' },
    // forex
    'bid': { label: 'Bid', fmt: 'fx' }, 'ask': { label: 'Ask', fmt: 'fx' }, 'spread': { label: 'Spread', fmt: 'num' },
    'high': { label: 'High', fmt: 'fx' }, 'low': { label: 'Low', fmt: 'fx' }, 'open': { label: 'Open', fmt: 'fx' },
    'base_currency': { label: 'Base', fmt: 'text' }, 'currency_quote': { label: 'Quote', fmt: 'text' },
    // bonds
    'current_yield': { label: 'Cur yield', fmt: 'pct' }, 'yield_to_maturity': { label: 'YTM', fmt: 'pct' },
    'yield_to_worst': { label: 'YTW', fmt: 'pct' }, 'current_coupon': { label: 'Coupon', fmt: 'pct' },
    'coupon': { label: 'Coupon', fmt: 'pct' }, 'maturity_date': { label: 'Maturity', fmt: 'date' },
    'issue_date': { label: 'Issued', fmt: 'date' }, 'days_to_maturity': { label: 'Days to mat', fmt: 'int' },
    'offer_price_pct': { label: 'Offer %', fmt: 'num2' }, 'close_net': { label: 'Price', fmt: 'num2' },
    'bid_net': { label: 'Bid', fmt: 'num2' }, 'ask_net': { label: 'Ask', fmt: 'num2' },
    'modified_duration': { label: 'Mod dur', fmt: 'num2' }, 'convexity': { label: 'Convexity', fmt: 'num2' }, 'dv_01': { label: 'DV01', fmt: 'num2' },
    'g_spread': { label: 'G-spread', fmt: 'num' }, 'z_spread': { label: 'Z-spread', fmt: 'num' }, 'f_spread': { label: 'F-spread', fmt: 'num' },
    'ytw_to_bid': { label: 'YTW bid', fmt: 'pct' }, 'ytw_to_ask': { label: 'YTW ask', fmt: 'pct' },
    'issue_amount': { label: 'Issue amt', fmt: 'big' }, 'outstanding_amount': { label: 'Outstanding', fmt: 'big' },
    'amount_outstanding_ratio': { label: 'Out %', fmt: 'pct' }, 'nominal_value': { label: 'Nominal', fmt: 'num' },
    'denom_min': { label: 'Min denom', fmt: 'num' }, 'denom_increment': { label: 'Denom step', fmt: 'num' },
    'issue_status.tr': { label: 'Status', fmt: 'text' }, 'duration_type.tr': { label: 'Duration type', fmt: 'text' },
    'placement_type.tr': { label: 'Placement', fmt: 'text' }, 'offer_type.tr': { label: 'Offer type', fmt: 'text' },
    'ownership_form.tr': { label: 'Ownership', fmt: 'text' }, 'coupon_frequency.tr': { label: 'Cpn freq', fmt: 'text' },
    'coupon_date_next': { label: 'Next cpn', fmt: 'date' }, 'coupon_date_prev': { label: 'Prev cpn', fmt: 'date' },
    'accrued_coupon_interest': { label: 'Accrued', fmt: 'num2' }, 'coupon_type_current.tr': { label: 'Cpn type', fmt: 'text' },
    'bond_issuer.tr': { label: 'Issuer', fmt: 'text' }, 'bond_issuer_stock_symbol': { label: 'Issuer stock', fmt: 'text' },
    'country.tr': { label: 'Country', fmt: 'text' }, 'country_code_fund': { fmt: 'hidden' },
    'issuer_snp_rating_lt.tr': { label: 'S&P LT', fmt: 'text' }, 'issuer_fitch_rating_lt.tr': { label: 'Fitch LT', fmt: 'text' },
    'issuer_moodys_rating_lt.tr': { label: "Moody's LT", fmt: 'text' },
    'seniority_level.tr': { label: 'Seniority', fmt: 'text' }, 'maturity_type.tr': { label: 'Mat type', fmt: 'text' },
    'call_next_date': { label: 'Next call', fmt: 'date' }, 'redemption_type.tr': { label: 'Redemption', fmt: 'text' },
    'rates_pct_change': { label: 'Chg %', fmt: 'pct', signed: true },
  };

  /* ---------------------------------------------------------------------------
   * Screener products: market path, base filter, default sort, column sets,
   * quick filters. Column sets mirror TradingView's tabs 1:1 where captured.
   * ------------------------------------------------------------------------ */
  const ID = ['name', 'description', 'logoid', 'type', 'typespecs', 'currency', 'exchange', 'update_mode'];
  const stockTypeFilter = {
    operator: 'and', operands: [
      { operation: { operator: 'or', operands: [
        { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'stock' } }, { expression: { left: 'typespecs', operation: 'has', right: ['common'] } }] } },
        { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'stock' } }, { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } }] } },
        { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'dr' } }] } },
        { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'fund' } }, { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual'] } }] } },
      ] } },
      { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
    ],
  };
  const etfTypeFilter = {
    operator: 'and', operands: [
      { operation: { operator: 'or', operands: [
        { operation: { operator: 'and', operands: [{ expression: { left: 'typespecs', operation: 'has', right: ['etf'] } }] } },
        { operation: { operator: 'and', operands: [{ expression: { left: 'type', operation: 'equal', right: 'structured' } }] } },
      ] } },
    ],
  };

  const PRODUCTS = {
    stocks: {
      label: 'Stocks', market: 'america', markets: ['america'], labelProduct: 'screener-stock-table',
      filter: [{ left: 'is_primary', operation: 'equal', right: true }],
      filter2: stockTypeFilter,
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      marketChoices: [['america', 'US'], ['ksa', 'Saudi Arabia'], ['uae', 'UAE'], ['qatar', 'Qatar'], ['kuwait', 'Kuwait'], ['uk', 'UK'], ['germany', 'Germany'], ['japan', 'Japan'], ['india', 'India'], ['hongkong', 'Hong Kong'], ['global', 'Global']],
      sets: {
        overview:    { label: 'Overview',    cols: ['close', 'change', 'volume', 'relative_volume_10d_calc', 'market_cap_basic', 'price_earnings_ttm', 'earnings_per_share_diluted_ttm', 'earnings_per_share_diluted_yoy_growth_ttm', 'dividends_yield_current', 'sector.tr', 'AnalystRating'] },
        performance: { label: 'Performance', cols: ['close', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'Perf.10Y', 'Perf.All', 'Volatility.W', 'Volatility.M'] },
        technicals:  { label: 'Technicals',  cols: ['close', 'change', 'TechRating_1D', 'MARating_1D', 'OsRating_1D', 'RSI', 'Mom', 'AO', 'CCI20', 'Stoch.K', 'Stoch.D', 'SMA50', 'SMA200', 'candlestick_patterns_1D'] },
        valuation:   { label: 'Valuation',   cols: ['market_cap_basic', 'Perf.1Y.MarketCap', 'price_earnings_ttm', 'price_earnings_growth_ttm', 'price_sales_current', 'price_book_fq', 'price_to_cash_f_operating_activities_ttm', 'price_free_cash_flow_ttm', 'price_to_cash_ratio', 'enterprise_value_current', 'enterprise_value_to_revenue_ttm', 'enterprise_value_to_ebit_ttm', 'enterprise_value_ebitda_ttm'] },
        dividends:   { label: 'Dividends',   cols: ['dps_common_stock_prim_issue_fy', 'dps_common_stock_prim_issue_fq', 'dividends_yield_current', 'dividends_yield', 'dividend_payout_ratio_ttm', 'dps_common_stock_prim_issue_yoy_growth_fy', 'continuous_dividend_payout', 'continuous_dividend_growth'] },
        profit:      { label: 'Profitability', cols: ['market_cap_basic', 'gross_margin', 'operating_margin', 'net_margin', 'return_on_equity', 'return_on_assets', 'total_revenue_yoy_growth_ttm', 'earnings_release_date', 'earnings_release_next_date', 'beta_1_year'] },
      },
      quick: [
        { id: 'mcap', label: 'Mkt cap', field: 'market_cap_basic', kind: 'range', unit: 'big', presets: [['Mega > 200B', 2e11, null], ['Large 10B–200B', 1e10, 2e11], ['Mid 2B–10B', 2e9, 1e10], ['Small 300M–2B', 3e8, 2e9], ['Micro < 300M', null, 3e8]] },
        { id: 'price', label: 'Price', field: 'close', kind: 'range', presets: [['< 5', null, 5], ['5–20', 5, 20], ['20–100', 20, 100], ['> 100', 100, null]] },
        { id: 'chg', label: 'Chg %', field: 'change', kind: 'range', presets: [['Up > 5%', 5, null], ['Up > 2%', 2, null], ['Down < −2%', null, -2], ['Down < −5%', null, -5]] },
        { id: 'vol', label: 'Volume', field: 'volume', kind: 'range', unit: 'big', presets: [['> 1M', 1e6, null], ['> 10M', 1e7, null], ['> 50M', 5e7, null]] },
        { id: 'relvol', label: 'Rel vol', field: 'relative_volume_10d_calc', kind: 'range', presets: [['> 1.5×', 1.5, null], ['> 2×', 2, null], ['> 3×', 3, null]] },
        { id: 'pe', label: 'P/E', field: 'price_earnings_ttm', kind: 'range', presets: [['< 15', 0, 15], ['15–30', 15, 30], ['> 30', 30, null], ['Negative', null, 0]] },
        { id: 'dy', label: 'Div yield', field: 'dividends_yield_current', kind: 'range', presets: [['> 2%', 2, null], ['> 4%', 4, null], ['> 6%', 6, null], ['None', null, 0.0001]] },
        { id: 'sector', label: 'Sector', field: 'sector', kind: 'in', options: ['Commercial Services', 'Communications', 'Consumer Durables', 'Consumer Non-Durables', 'Consumer Services', 'Distribution Services', 'Electronic Technology', 'Energy Minerals', 'Finance', 'Health Services', 'Health Technology', 'Industrial Services', 'Miscellaneous', 'Non-Energy Minerals', 'Process Industries', 'Producer Manufacturing', 'Retail Trade', 'Technology Services', 'Transportation', 'Utilities'] },
        { id: 'rating', label: 'Analyst', field: 'AnalystRating', kind: 'in', options: ['Strong Buy', 'Buy', 'Neutral', 'Sell', 'Strong Sell'] },
        { id: 'rsi', label: 'RSI', field: 'RSI', kind: 'range', presets: [['Oversold < 30', null, 30], ['Overbought > 70', 70, null], ['30–70', 30, 70]] },
        { id: 'tech', label: 'Tech rating', field: 'Recommend.All', kind: 'range', presets: [['Strong buy', 0.5, null], ['Buy', 0.1, 0.5], ['Neutral', -0.1, 0.1], ['Sell', -0.5, -0.1], ['Strong sell', null, -0.5]] },
      ],
      presets: {
        'Top gainers':        { sort: { sortBy: 'change', sortOrder: 'desc' }, filters: { vol: [1e6, null], price: [1, null] } },
        'Top losers':         { sort: { sortBy: 'change', sortOrder: 'asc' }, filters: { vol: [1e6, null], price: [1, null] } },
        'Most active':        { sort: { sortBy: 'volume', sortOrder: 'desc' } },
        'Unusual volume':     { sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }, filters: { vol: [1e6, null], relvol: [2, null] } },
        'Large-cap value':    { sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, filters: { mcap: [1e10, null], pe: [0, 15], dy: [2, null] } },
        'Oversold large caps':{ sort: { sortBy: 'RSI', sortOrder: 'asc' }, filters: { mcap: [1e10, null], rsi: [null, 30] } },
        'Overbought':         { sort: { sortBy: 'RSI', sortOrder: 'desc' }, filters: { rsi: [70, null], vol: [1e6, null] } },
        'High dividend':      { sort: { sortBy: 'dividends_yield_current', sortOrder: 'desc' }, filters: { dy: [4, null], mcap: [2e9, null] } },
        'Strong buy + uptrend': { sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, filters: { rating: ['Strong Buy'], tech: [0.1, null] } },
      },
    },
    etf: {
      label: 'ETFs', market: 'america', markets: ['america'], labelProduct: 'screener-etf',
      filter: [], filter2: etfTypeFilter,
      sort: { sortBy: 'aum', sortOrder: 'desc' },
      marketChoices: [['america', 'US'], ['uk', 'UK'], ['germany', 'Germany'], ['ksa', 'Saudi Arabia'], ['global', 'Global']],
      sets: {
        overview:    { label: 'Overview',    cols: ['close', 'change', 'Value.Traded', 'relative_volume_10d_calc', 'aum', 'nav_total_return.3Y', 'etf_holdings_count', 'expense_ratio', 'asset_class.tr', 'focus.tr'] },
        performance: { label: 'Performance', cols: ['close', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'Perf.10Y', 'Perf.All'] },
        technicals:  { label: 'Technicals',  cols: ['close', 'change', 'TechRating_1D', 'MARating_1D', 'OsRating_1D', 'RSI', 'Mom', 'AO', 'CCI20', 'Stoch.K', 'Stoch.D', 'candlestick_patterns_1D'] },
        flows:       { label: 'Fund flows',  cols: ['aum', 'fund_flows.1M', 'fund_flows.3M', 'fund_flows.YTD', 'fund_flows.1Y', 'fund_flows.3Y'] },
        dividends:   { label: 'Dividends',   cols: ['close', 'dividends_yield', 'indicated_annual_dividend', 'dividends_frequency.tr', 'dividend_treatment.tr'] },
        nav:         { label: 'NAV',         cols: ['nav', 'nav_discount_premium', 'nav_perf.1M', 'nav_perf.3M', 'nav_perf.1Y', 'nav_perf.3Y', 'nav_perf.YTD', 'nav_total_return.1M', 'nav_total_return.3M', 'nav_total_return.1Y', 'nav_total_return.3Y', 'nav_total_return.YTD'] },
      },
      quick: [
        { id: 'aum', label: 'AUM', field: 'aum', kind: 'range', unit: 'big', presets: [['> 1B', 1e9, null], ['> 10B', 1e10, null], ['> 50B', 5e10, null], ['< 1B', null, 1e9]] },
        { id: 'er', label: 'Expense', field: 'expense_ratio', kind: 'range', presets: [['< 0.1%', null, 0.1], ['< 0.3%', null, 0.3], ['> 0.5%', 0.5, null]] },
        { id: 'chg', label: 'Chg %', field: 'change', kind: 'range', presets: [['Up > 1%', 1, null], ['Up > 3%', 3, null], ['Down < −1%', null, -1], ['Down < −3%', null, -3]] },
        { id: 'dy', label: 'Div yield', field: 'dividends_yield', kind: 'range', presets: [['> 2%', 2, null], ['> 4%', 4, null], ['> 8%', 8, null]] },
        { id: 'class', label: 'Asset class', field: 'asset_class', kind: 'in', options: ['Equity', 'Fixed income', 'Commodity', 'Currency', 'Alternative', 'Multi-asset'] },
      ],
      presets: {
        'Largest':       { sort: { sortBy: 'aum', sortOrder: 'desc' } },
        'Top inflows 1M':{ sort: { sortBy: 'fund_flows.1M', sortOrder: 'desc' }, filters: { aum: [1e9, null] } },
        'Top outflows 1M':{ sort: { sortBy: 'fund_flows.1M', sortOrder: 'asc' }, filters: { aum: [1e9, null] } },
        'Cheapest (fee)':{ sort: { sortBy: 'expense_ratio', sortOrder: 'asc' }, filters: { aum: [1e9, null] } },
        'Top 1Y':        { sort: { sortBy: 'Perf.Y', sortOrder: 'desc' }, filters: { aum: [1e9, null] } },
        'Income':        { sort: { sortBy: 'dividends_yield', sortOrder: 'desc' }, filters: { aum: [1e9, null], dy: [4, null] } },
      },
    },
    crypto: {
      label: 'Crypto', market: 'coin', markets: undefined, labelProduct: 'screener-coin',
      filter: [], filter2: undefined,
      sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' },
      idCols: ['base_currency', 'base_currency_desc', 'base_currency_logoid', 'type', 'typespecs', 'currency', 'exchange', 'update_mode'],
      sets: {
        overview:    { label: 'Overview',    cols: ['crypto_total_rank', 'close', 'change', 'market_cap_calc', 'market_cap_diluted_calc', '24h_vol_cmc', '24h_vol_to_market_cap', 'circulating_supply', 'crypto_common_categories.tr'] },
        performance: { label: 'Performance', cols: ['close', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Volatility.W', 'Volatility.M'] },
        technicals:  { label: 'Technicals',  cols: ['close', 'change', 'TechRating_1D', 'MARating_1D', 'OsRating_1D', 'RSI', 'Mom', 'AO', 'CCI20', 'Stoch.K', 'Stoch.D'] },
        supply:      { label: 'Supply',      cols: ['market_cap_calc', 'circulating_supply', 'total_supply', 'max_supply', 'market_cap_diluted_calc', 'crypto_blockchain_ecosystems.tr'] },
      },
      quick: [
        { id: 'mcap', label: 'Mkt cap', field: 'market_cap_calc', kind: 'range', unit: 'big', presets: [['> 10B', 1e10, null], ['1B–10B', 1e9, 1e10], ['100M–1B', 1e8, 1e9], ['< 100M', null, 1e8]] },
        { id: 'chg', label: 'Chg %', field: 'change', kind: 'range', presets: [['Up > 5%', 5, null], ['Up > 10%', 10, null], ['Down < −5%', null, -5], ['Down < −10%', null, -10]] },
        { id: 'vol', label: '24h vol', field: '24h_vol_cmc', kind: 'range', unit: 'big', presets: [['> 10M', 1e7, null], ['> 100M', 1e8, null], ['> 1B', 1e9, null]] },
        { id: 'rsi', label: 'RSI', field: 'RSI', kind: 'range', presets: [['Oversold < 30', null, 30], ['Overbought > 70', 70, null]] },
      ],
      presets: {
        'By rank':        { sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' } },
        'Top gainers':    { sort: { sortBy: 'change', sortOrder: 'desc' }, filters: { vol: [1e7, null] } },
        'Top losers':     { sort: { sortBy: 'change', sortOrder: 'asc' }, filters: { vol: [1e7, null] } },
        'Most traded':    { sort: { sortBy: '24h_vol_cmc', sortOrder: 'desc' } },
        'Hot (vol/mcap)': { sort: { sortBy: '24h_vol_to_market_cap', sortOrder: 'desc' }, filters: { mcap: [1e8, null] } },
      },
    },
    forex: {
      label: 'Forex', market: 'forex', markets: undefined, labelProduct: 'screener-forex',
      filter: [{ left: 'sector', operation: 'in_range', right: ['Major', 'Minor', 'Exotic'] }], filter2: undefined,
      sort: { sortBy: 'name', sortOrder: 'asc' },
      idCols: ['name', 'description', 'type', 'typespecs', 'currency', 'exchange', 'update_mode'],
      sets: {
        overview:    { label: 'Overview',    cols: ['close', 'change', 'change_abs', 'bid', 'ask', 'high', 'low', 'sector'] },
        performance: { label: 'Performance', cols: ['close', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Volatility.W', 'Volatility.M'] },
        technicals:  { label: 'Technicals',  cols: ['close', 'change', 'TechRating_1D', 'MARating_1D', 'OsRating_1D', 'RSI', 'Mom', 'AO', 'CCI20', 'Stoch.K', 'Stoch.D', 'ATR', 'ADX'] },
      },
      quick: [
        { id: 'group', label: 'Group', field: 'sector', kind: 'in', options: ['Major', 'Minor', 'Exotic'] },
        { id: 'chg', label: 'Chg %', field: 'change', kind: 'range', presets: [['Up > 0.3%', 0.3, null], ['Up > 1%', 1, null], ['Down < −0.3%', null, -0.3], ['Down < −1%', null, -1]] },
        { id: 'rsi', label: 'RSI', field: 'RSI', kind: 'range', presets: [['Oversold < 30', null, 30], ['Overbought > 70', 70, null]] },
      ],
      presets: {
        'Majors':      { sort: { sortBy: 'name', sortOrder: 'asc' }, filters: { group: ['Major'] } },
        'Top movers':  { sort: { sortBy: 'change', sortOrder: 'desc' } },
        'Worst movers':{ sort: { sortBy: 'change', sortOrder: 'asc' } },
        'Trending (ADX)': { sort: { sortBy: 'ADX', sortOrder: 'desc' }, filters: { group: ['Major', 'Minor'] } },
      },
    },
    bonds: {
      label: 'Bonds', market: 'bond', markets: undefined, labelProduct: 'screener-bond',
      // TradingView's base filter for its public bond screener (captured): BONDSCOM exchange,
      // traded in last 5 days, outstanding >= 100M, sane YTM.
      filter: [{ left: 'exchange', operation: 'in_range', right: ['BONDSCOM'] }],
      filter2: { operator: 'and', operands: [
        { expression: { left: 'time', operation: 'in_day_range', right: [-5, 0] } },
        { operation: { operator: 'or', operands: [{ expression: { left: 'outstanding_amount', operation: 'empty' } }, { expression: { left: 'outstanding_amount', operation: 'egreater', right: 1e8 } }] } },
        { operation: { operator: 'or', operands: [{ expression: { left: 'yield_to_maturity', operation: 'empty' } }, { operation: { operator: 'and', operands: [{ expression: { left: 'yield_to_maturity', operation: 'greater', right: 1.5 } }, { expression: { left: 'yield_to_maturity', operation: 'eless', right: 20 } }] } }] } },
      ] },
      sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' },
      idCols: ['name', 'description', 'type', 'typespecs', 'currency', 'exchange', 'update_mode'],
      sets: {
        overview:   { label: 'Overview',  cols: ['close_net', 'current_yield', 'yield_to_maturity', 'current_coupon', 'maturity_date', 'days_to_maturity', 'country.tr', 'bond_issuer.tr', 'issuer_snp_rating_lt.tr'] },
        rate:       { label: 'Rate risk', cols: ['close_net', 'yield_to_worst', 'yield_to_maturity', 'current_coupon', 'maturity_date', 'modified_duration', 'convexity', 'dv_01'] },
        spreads:    { label: 'Spreads',   cols: ['close_net', 'bid_net', 'ask_net', 'yield_to_maturity', 'yield_to_worst', 'ytw_to_bid', 'ytw_to_ask', 'g_spread', 'z_spread', 'f_spread'] },
        amounts:    { label: 'Amounts',   cols: ['issue_amount', 'outstanding_amount', 'amount_outstanding_ratio', 'nominal_value', 'denom_min', 'denom_increment'] },
        coupon:     { label: 'Coupon',    cols: ['current_coupon', 'coupon_frequency.tr', 'coupon_date_next', 'coupon_date_prev', 'accrued_coupon_interest', 'coupon_type_current.tr'] },
        issuer:     { label: 'Issuer',    cols: ['bond_issuer.tr', 'bond_issuer_stock_symbol', 'country.tr', 'sector.tr', 'industry.tr', 'issuer_snp_rating_lt.tr', 'issuer_fitch_rating_lt.tr', 'issuer_moodys_rating_lt.tr'] },
        terms:      { label: 'Terms',     cols: ['seniority_level.tr', 'maturity_type.tr', 'redemption_type.tr', 'call_next_date', 'issue_date', 'maturity_date', 'issue_status.tr', 'placement_type.tr'] },
      },
      quick: [
        { id: 'ytm', label: 'YTM', field: 'yield_to_maturity', kind: 'range', presets: [['> 4%', 4, null], ['> 6%', 6, null], ['> 8%', 8, null], ['< 4%', null, 4]] },
        { id: 'mat', label: 'Maturity', field: 'days_to_maturity', kind: 'range', presets: [['< 1Y', null, 365], ['1–3Y', 365, 1095], ['3–7Y', 1095, 2555], ['7–15Y', 2555, 5475], ['> 15Y', 5475, null]] },
        { id: 'cpn', label: 'Coupon', field: 'current_coupon', kind: 'range', presets: [['> 3%', 3, null], ['> 5%', 5, null], ['Zero', null, 0.0001]] },
        { id: 'dur', label: 'Mod dur', field: 'modified_duration', kind: 'range', presets: [['< 2', null, 2], ['2–5', 2, 5], ['5–10', 5, 10], ['> 10', 10, null]] },
        { id: 'country', label: 'Country', field: 'country_code_fund', kind: 'in', options: ['US', 'SA', 'AE', 'QA', 'KW', 'GB', 'DE', 'FR', 'JP', 'CN'] },
        { id: 'snp', label: 'S&P', field: 'issuer_snp_rating_lt', kind: 'in', options: ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-'] },
      ],
      presets: {
        'Highest YTM':     { sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' } },
        'Short duration':  { sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' }, filters: { dur: [null, 2] } },
        'Investment grade':{ sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' }, filters: { snp: ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-'] } },
        'High yield':      { sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' }, filters: { snp: ['BB+', 'BB', 'BB-', 'B+', 'B', 'B-'] } },
        'GCC issuers':     { sort: { sortBy: 'yield_to_maturity', sortOrder: 'desc' }, filters: { country: ['SA', 'AE', 'QA', 'KW'] } },
        'Maturing < 1Y':   { sort: { sortBy: 'days_to_maturity', sortOrder: 'asc' }, filters: { mat: [null, 365] } },
      },
    },
  };

  /* ---------------------------------------------------------------------------
   * Yield-curve catalogue. TradingView publishes government benchmark yields
   * as TVC:<CC><tenor>Y (and ..MY for months). Tenors differ by country.
   * ------------------------------------------------------------------------ */
  const TENORS = [
    ['01M', '1M', 1 / 12], ['02M', '2M', 2 / 12], ['03M', '3M', 0.25], ['04M', '4M', 4 / 12], ['06M', '6M', 0.5],
    ['01Y', '1Y', 1], ['02Y', '2Y', 2], ['03Y', '3Y', 3], ['05Y', '5Y', 5], ['07Y', '7Y', 7], ['10Y', '10Y', 10],
    ['15Y', '15Y', 15], ['20Y', '20Y', 20], ['25Y', '25Y', 25], ['30Y', '30Y', 30], ['40Y', '40Y', 40], ['50Y', '50Y', 50],
  ];
  const CURVES = {
    US: { label: 'United States', flag: '🇺🇸', prefix: 'US', tenors: ['01M', '02M', '03M', '04M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'], official: 'treasury' },
    GB: { label: 'United Kingdom', flag: '🇬🇧', prefix: 'GB', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y', '50Y'] },
    DE: { label: 'Germany',        flag: '🇩🇪', prefix: 'DE', tenors: ['03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    FR: { label: 'France',         flag: '🇫🇷', prefix: 'FR', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    IT: { label: 'Italy',          flag: '🇮🇹', prefix: 'IT', tenors: ['03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    JP: { label: 'Japan',          flag: '🇯🇵', prefix: 'JP', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y', '40Y'] },
    CA: { label: 'Canada',         flag: '🇨🇦', prefix: 'CA', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'] },
    AU: { label: 'Australia',      flag: '🇦🇺', prefix: 'AU', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    CN: { label: 'China',          flag: '🇨🇳', prefix: 'CN', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    IN: { label: 'India',          flag: '🇮🇳', prefix: 'IN', tenors: ['03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    KR: { label: 'South Korea',    flag: '🇰🇷', prefix: 'KR', tenors: ['01Y', '02Y', '03Y', '05Y', '10Y', '20Y', '30Y'] },
    CH: { label: 'Switzerland',    flag: '🇨🇭', prefix: 'CH', tenors: ['01M', '03M', '06M', '01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'] },
    // GCC: coverage on TradingView is partial; tenors that return no data are hidden automatically.
    SA: { label: 'Saudi Arabia',   flag: '🇸🇦', prefix: 'SA', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '15Y', '20Y', '30Y'], gcc: true },
    AE: { label: 'UAE',            flag: '🇦🇪', prefix: 'AE', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'], gcc: true },
    QA: { label: 'Qatar',          flag: '🇶🇦', prefix: 'QA', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'], gcc: true },
    BH: { label: 'Bahrain',        flag: '🇧🇭', prefix: 'BH', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'], gcc: true },
    KW: { label: 'Kuwait',         flag: '🇰🇼', prefix: 'KW', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y'], gcc: true },
    OM: { label: 'Oman',           flag: '🇴🇲', prefix: 'OM', tenors: ['01Y', '02Y', '03Y', '05Y', '07Y', '10Y', '20Y', '30Y'], gcc: true },
  };
  const tenorMeta = (code) => TENORS.find(t => t[0] === code);
  const tenorSymbol = (cc, code) => `TVC:${CURVES[cc].prefix}${code.endsWith('M') ? code + 'Y' : code}`; // TVC:US03MY, TVC:US10Y

  /* ---------------------------------------------------------------------------
   * Formatting
   * ------------------------------------------------------------------------ */
  const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = {
    big(v, signed) {
      if (v == null || isNaN(v)) return '—';
      const a = Math.abs(v); let s;
      if (a >= 1e12) s = nf(2).format(a / 1e12) + ' T';
      else if (a >= 1e9) s = nf(2).format(a / 1e9) + ' B';
      else if (a >= 1e6) s = nf(2).format(a / 1e6) + ' M';
      else if (a >= 1e3) s = nf(2).format(a / 1e3) + ' K';
      else s = nf(0).format(a);
      return (v < 0 ? '−' : signed && v > 0 ? '+' : '') + s;
    },
    pct(v, signed) { if (v == null || isNaN(v)) return '—'; return (v < 0 ? '−' : signed && v > 0 ? '+' : '') + nf(2).format(Math.abs(v)) + '%'; },
    num(v, signed) { if (v == null || isNaN(v)) return '—'; return (v < 0 ? '−' : signed && v > 0 ? '+' : '') + nf(Math.abs(v) < 10 ? 4 : 2).format(Math.abs(v)); },
    num2(v, signed) { if (v == null || isNaN(v)) return '—'; return (v < 0 ? '−' : signed && v > 0 ? '+' : '') + nf(2).format(Math.abs(v)); },
    int(v) { if (v == null || isNaN(v)) return '—'; return nf(0).format(v); },
    price(v, _s, row) {
      if (v == null || isNaN(v)) return '—';
      const ps = row && row._pricescale, mm = row && row._minmov;
      let d = 2; if (ps && mm) d = Math.max(0, Math.round(Math.log10(ps / mm)));
      else if (Math.abs(v) < 1) d = 4;
      return nf(Math.min(d, 8)).format(v);
    },
    fx(v) { if (v == null || isNaN(v)) return '—'; return nf(Math.abs(v) > 50 ? 3 : 5).format(v); },
    date(v) { if (!v) return '—'; const d = new Date(typeof v === 'number' ? v * 1000 : v); return isNaN(d) ? '—' : d.toISOString().slice(0, 10); },
    text(v) { return v == null || v === '' ? '—' : String(v); },
    sym(v) { return v == null ? '—' : String(v); },
    rating(v) { return v == null ? '—' : String(v); },
    techrating(v) {
      // TradingView returns TechRating_1D as a string ("StrongBuy", "Buy", "Neutral", "Sell", "StrongSell")
      // and Recommend.All as a number in [-1, 1].
      if (v == null) return '—';
      if (typeof v === 'string') return v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(\w)(\w*) ?(\w*)/, (m, a, b, c) => a + b + (c ? ' ' + c.toLowerCase() : ''));
      if (isNaN(v)) return '—';
      return v > 0.5 ? 'Strong buy' : v > 0.1 ? 'Buy' : v >= -0.1 ? 'Neutral' : v >= -0.5 ? 'Sell' : 'Strong sell';
    },
    hidden() { return ''; },
  };
  function formatCell(field, v, row) {
    const m = F[field] || { fmt: 'text' };
    const f = fmt[m.fmt] || fmt.text;
    return f(v, m.signed, row);
  }
  function cellClass(field, v) {
    const m = F[field] || {};
    const cls = [];
    if (['pct', 'num', 'num2', 'big', 'price', 'fx', 'int'].includes(m.fmt)) cls.push('num');
    if (m.signed && typeof v === 'number') cls.push(v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
    if (m.fmt === 'rating' || m.fmt === 'techrating') {
      const s = m.fmt === 'rating' ? String(v || '') : fmt.techrating(v);
      cls.push(/strong buy/i.test(s) ? 'r-sb' : /buy/i.test(s) ? 'r-b' : /strong sell/i.test(s) ? 'r-ss' : /sell/i.test(s) ? 'r-s' : 'r-n');
    }
    return cls.join(' ');
  }

  /* ---------------------------------------------------------------------------
   * Transport: direct → proxy, with timeout, in-memory cache and localStorage
   * last-good snapshot.
   * ------------------------------------------------------------------------ */
  const memCache = new Map();
  const state = { transport: null, lastError: null };

  async function postJSON(url, body, { timeoutMs = TD_CONFIG.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function scan(market, body, { label = TD_CONFIG.label, cacheKey, ttl = TD_CONFIG.cacheTTL } = {}) {
    const key = cacheKey || (market + ':' + JSON.stringify(body));
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < ttl) return Object.assign({}, hit.v, { cached: true });

    const payload = Object.assign({ options: { lang: TD_CONFIG.lang }, ignore_unknown_fields: false }, body);
    const attempts = [
      ['direct', `${TD_CONFIG.scannerBase}/${market}/scan?label-product=${encodeURIComponent(label)}`],
      ['proxy',  `${TD_CONFIG.proxyBase}/tv/${market}/scan?label-product=${encodeURIComponent(label)}`],
    ];
    // Remember which transport worked last time and try it first.
    if (state.transport === 'proxy') attempts.reverse();
    let lastErr;
    for (const [name, url] of attempts) {
      try {
        const j = await postJSON(url, payload);
        if (!j || !Array.isArray(j.data)) throw new Error('Bad scanner reply');
        state.transport = name; state.lastError = null;
        const v = { totalCount: j.totalCount, data: j.data, transport: name, at: Date.now() };
        memCache.set(key, { t: Date.now(), v });
        try { localStorage.setItem('td:snap:' + hash(key), JSON.stringify(v)); } catch (e) { /* storage may be unavailable */ }
        return v;
      } catch (e) { lastErr = e; }
    }
    state.lastError = lastErr;
    // Stale snapshot as last resort
    try {
      const s = localStorage.getItem('td:snap:' + hash(key));
      if (s) { const v = JSON.parse(s); v.stale = true; v.transport = 'snapshot'; return v; }
    } catch (e) { /* ignore */ }
    throw lastErr || new Error('Scanner unavailable');
  }

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

  /* ---------------------------------------------------------------------------
   * Screener query builder
   * ------------------------------------------------------------------------ */
  function buildFilterOperands(product, active) {
    const ops = [];
    for (const q of product.quick) {
      const val = active[q.id];
      if (val == null) continue;
      if (q.kind === 'in') {
        if (Array.isArray(val) && val.length) ops.push({ expression: { left: q.field, operation: 'in_range', right: val } });
      } else if (q.kind === 'range') {
        const [lo, hi] = val;
        if (lo != null) ops.push({ expression: { left: q.field, operation: 'egreater', right: lo } });
        if (hi != null) ops.push({ expression: { left: q.field, operation: 'eless', right: hi } });
      }
    }
    return ops;
  }

  function buildScreenerBody(productId, { set = 'overview', market, filters = {}, sort, range = [0, 100], search } = {}) {
    const p = PRODUCTS[productId];
    const idCols = p.idCols || ID;
    const dataCols = p.sets[set].cols;
    const columns = [...idCols, ...dataCols.filter(c => !idCols.includes(c))];
    // price precision helpers, when present
    if (!columns.includes('pricescale')) columns.push('pricescale', 'minmov', 'fractional', 'minmove2');
    const operands = [];
    if (p.filter2) operands.push({ operation: p.filter2 });
    operands.push(...buildFilterOperands(p, filters));
    if (search) operands.push({ expression: { left: 'name,description', operation: 'match', right: String(search).trim() } });
    const body = {
      columns,
      filter: p.filter ? p.filter.slice() : [],
      sort: sort || p.sort,
      range,
    };
    if (operands.length) body.filter2 = { operator: 'and', operands };
    const mkt = market || p.market;
    if (p.markets !== undefined) body.markets = [mkt];
    return { body, market: p.markets !== undefined ? mkt : p.market, columns, dataCols, idCols };
  }

  function rowsFromReply(reply, columns) {
    return reply.data.map(({ s, d }) => {
      const row = { _symbol: s };
      columns.forEach((c, i) => { row[c] = d[i]; });
      row._ticker = row.name || row.base_currency || s.split(':')[1];
      row._name = row.description || row.base_currency_desc || '';
      row._exchange = row.exchange || s.split(':')[0];
      row._pricescale = row.pricescale; row._minmov = row.minmov;
      row._logo = row.logoid || row.base_currency_logoid;
      return row;
    });
  }

  async function runScreener(productId, opts = {}) {
    const q = buildScreenerBody(productId, opts);
    const reply = await scan(q.market, q.body, { label: PRODUCTS[productId].labelProduct });
    return { rows: rowsFromReply(reply, q.columns), total: reply.totalCount, columns: q.dataCols, transport: reply.transport, stale: !!reply.stale, cached: !!reply.cached, at: reply.at };
  }

  /* ---------------------------------------------------------------------------
   * Yield curves
   * ------------------------------------------------------------------------ */
  async function fetchCurveTV(cc) {
    const c = CURVES[cc];
    const tickers = c.tenors.map(t => tenorSymbol(cc, t));
    const reply = await scan('global', {
      columns: ['close', 'change', 'change_abs', 'high', 'low', 'open', 'update_mode', 'time'],
      symbols: { tickers },
      range: [0, tickers.length],
    }, { label: 'yield-curve', ttl: 5 * 60 * 1000 });
    const bySym = new Map(reply.data.map(r => [r.s, r.d]));
    const points = [];
    for (const t of c.tenors) {
      const d = bySym.get(tenorSymbol(cc, t));
      if (!d || d[0] == null) continue;
      const tm = tenorMeta(t);
      points.push({ tenor: tm[1], years: tm[2], yield: d[0], chgPct: d[1], chgAbs: d[2], high: d[3], low: d[4], open: d[5] });
    }
    return { cc, label: c.label, flag: c.flag, points, source: 'tradingview', transport: reply.transport, stale: !!reply.stale, at: reply.at };
  }

  async function fetchCurveOfficial(cc) {
    // Served by proxy/server.js: US Treasury daily par curve (no key) + FRED (key) for history.
    const r = await fetch(`${TD_CONFIG.proxyBase}/yields/${cc}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json(); // { date, points:[{tenor, years, yield}], history?: {...} }
    return Object.assign({ cc, label: CURVES[cc].label, flag: CURVES[cc].flag, source: 'official', transport: 'proxy', at: Date.now() }, j);
  }

  async function fetchCurve(cc) {
    let err;
    try { const v = await fetchCurveTV(cc); if (v.points.length >= 3) return v; err = new Error('Too few tenors from TradingView'); } catch (e) { err = e; }
    if (CURVES[cc].official) { try { return await fetchCurveOfficial(cc); } catch (e) { err = e; } }
    throw err;
  }

  /* History: daily snapshots in localStorage (free, any country) + optional
   * official history from the proxy for the US. */
  function saveCurveSnapshot(curve) {
    try {
      const k = 'td:yc:' + curve.cc;
      const hist = JSON.parse(localStorage.getItem(k) || '{}');
      const day = new Date(curve.at || Date.now()).toISOString().slice(0, 10);
      hist[day] = curve.points.map(p => [p.tenor, p.yield]);
      const days = Object.keys(hist).sort();
      while (days.length > 400) delete hist[days.shift()];
      localStorage.setItem(k, JSON.stringify(hist));
    } catch (e) { /* ignore */ }
  }
  function curveSnapshotNear(cc, daysAgo) {
    try {
      const hist = JSON.parse(localStorage.getItem('td:yc:' + cc) || '{}');
      const target = Date.now() - daysAgo * 864e5;
      let best = null, bestDiff = Infinity;
      for (const day of Object.keys(hist)) {
        const diff = Math.abs(new Date(day).getTime() - target);
        if (diff < bestDiff && diff < 10 * 864e5) { best = day; bestDiff = diff; }
      }
      return best ? { day: best, points: hist[best].map(([tenor, y]) => ({ tenor, yield: y, years: (TENORS.find(t => t[1] === tenor) || [])[2] })) } : null;
    } catch (e) { return null; }
  }
  async function fetchCurveHistory(cc, daysAgo) {
    const local = curveSnapshotNear(cc, daysAgo);
    if (local) return local;
    try {
      const r = await fetch(`${TD_CONFIG.proxyBase}/yields/${cc}/history?daysAgo=${daysAgo}`, { credentials: 'same-origin' });
      if (r.ok) return await r.json();
    } catch (e) { /* ignore */ }
    return null;
  }

  function spreads(points) {
    const by = Object.fromEntries(points.map(p => [p.tenor, p.yield]));
    const mk = (a, b, label) => (by[a] != null && by[b] != null) ? { label, a, b, bp: Math.round((by[b] - by[a]) * 100), inverted: by[b] < by[a] } : null;
    return [mk('2Y', '10Y', '2s10s'), mk('3M', '10Y', '3m10y'), mk('5Y', '30Y', '5s30s'), mk('2Y', '30Y', '2s30s'), mk('1Y', '10Y', '1s10s')].filter(Boolean);
  }

  global.TD = Object.assign(global.TD || {}, {
    config: TD_CONFIG, FIELDS: F, PRODUCTS, CURVES, TENORS, fmt, formatCell, cellClass,
    scan, buildScreenerBody, runScreener, rowsFromReply,
    fetchCurve, fetchCurveTV, fetchCurveOfficial, fetchCurveHistory, saveCurveSnapshot, spreads, tenorSymbol,
    state,
  });
})(window);

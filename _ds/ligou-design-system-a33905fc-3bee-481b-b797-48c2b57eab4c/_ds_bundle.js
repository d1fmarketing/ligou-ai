/* @ds-bundle: {"format":4,"namespace":"LigouDesignSystem_a33905","components":[{"name":"CalloutCapsule","sourcePath":"components/brand/CalloutCapsule.jsx"},{"name":"Eyebrow","sourcePath":"components/brand/Eyebrow.jsx"},{"name":"StepBadge","sourcePath":"components/brand/StepBadge.jsx"},{"name":"WaveDivider","sourcePath":"components/brand/WaveDivider.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Dialog","sourcePath":"components/feedback/Dialog.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"DemoSection","sourcePath":"ui_kits/site/DemoSection.jsx"},{"name":"FaqSection","sourcePath":"ui_kits/site/FaqSection.jsx"},{"name":"Hero","sourcePath":"ui_kits/site/Hero.jsx"},{"name":"HowSection","sourcePath":"ui_kits/site/HowSection.jsx"},{"name":"Landing","sourcePath":"ui_kits/site/Landing.jsx"},{"name":"PricingSection","sourcePath":"ui_kits/site/PricingSection.jsx"},{"name":"ASSETS","sourcePath":"ui_kits/site/SiteChrome.jsx"},{"name":"Container","sourcePath":"ui_kits/site/SiteChrome.jsx"},{"name":"SectionHead","sourcePath":"ui_kits/site/SiteChrome.jsx"},{"name":"SiteNav","sourcePath":"ui_kits/site/SiteChrome.jsx"},{"name":"SiteFooter","sourcePath":"ui_kits/site/SiteChrome.jsx"}],"sourceHashes":{"components/brand/CalloutCapsule.jsx":"1643ade2e9bf","components/brand/Eyebrow.jsx":"c9c5f517e1f8","components/brand/StepBadge.jsx":"a656e484fd34","components/brand/WaveDivider.jsx":"5dd51c5137af","components/core/Badge.jsx":"ebc1099cafac","components/core/Button.jsx":"c0451295875f","components/core/Card.jsx":"ab65dd672a1b","components/core/IconButton.jsx":"c3bd706a90b6","components/core/Tag.jsx":"494644e034cf","components/feedback/Dialog.jsx":"2ec02797e366","components/feedback/Toast.jsx":"26832ab4aa56","components/feedback/Tooltip.jsx":"011d5ec980f9","components/forms/Checkbox.jsx":"de4d3e90a31e","components/forms/Input.jsx":"6fda460e5150","components/forms/Radio.jsx":"c758f155bd76","components/forms/Select.jsx":"5e1dac28f6a1","components/forms/Switch.jsx":"6e39a60355c2","components/navigation/Tabs.jsx":"278fc991212f","ui_kits/site/DemoSection.jsx":"832708e94d32","ui_kits/site/FaqSection.jsx":"049b7ba20bb3","ui_kits/site/Hero.jsx":"4c665d45df1f","ui_kits/site/HowSection.jsx":"095ba4d8cc0e","ui_kits/site/Landing.jsx":"f564a359fcbc","ui_kits/site/PricingSection.jsx":"91ca66f4b9f9","ui_kits/site/SiteChrome.jsx":"fd88ca025b78"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.LigouDesignSystem_a33905 = window.LigouDesignSystem_a33905 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/CalloutCapsule.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function CalloutCapsule({
  label,
  line,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['lg-capsule', className].filter(Boolean).join(' ')
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "lg-capsule__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "lg-capsule__line"
  }, line || children));
}
Object.assign(__ds_scope, { CalloutCapsule });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/CalloutCapsule.jsx", error: String((e && e.message) || e) }); }

// components/brand/Eyebrow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Eyebrow({
  bare,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['lg-eyebrow', bare ? 'lg-eyebrow--bare' : '', className].filter(Boolean).join(' ')
  }, rest), children);
}
Object.assign(__ds_scope, { Eyebrow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/Eyebrow.jsx", error: String((e && e.message) || e) }); }

// components/brand/StepBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function StepBadge({
  n,
  label,
  active,
  dot,
  className = '',
  ...rest
}) {
  const cls = ['lg-step', active ? 'lg-step--active' : '', className].filter(Boolean).join(' ');
  if (dot) return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "lg-step__dot"
  }, n), label && /*#__PURE__*/React.createElement("span", null, label));
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "lg-step__n"
  }, n), label && /*#__PURE__*/React.createElement(React.Fragment, null, "\xB7", /*#__PURE__*/React.createElement("span", null, label)));
}
Object.assign(__ds_scope, { StepBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/StepBadge.jsx", error: String((e && e.message) || e) }); }

// components/brand/WaveDivider.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function WaveDivider({
  className = '',
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("svg", _extends({
    className: ['lg-wave', className].filter(Boolean).join(' '),
    style: style,
    viewBox: "0 0 1200 22",
    fill: "none",
    preserveAspectRatio: "none",
    "aria-hidden": "true"
  }, rest), /*#__PURE__*/React.createElement("path", {
    d: "M0 11c75-14 150-14 225 0s150 14 225 0 150-14 225 0 150 14 225 0 150-14 225 0 75 7 75 7",
    stroke: "currentColor",
    strokeWidth: "3",
    strokeLinecap: "round"
  }));
}
Object.assign(__ds_scope, { WaveDivider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/WaveDivider.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Badge({
  variant = 'teal',
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['lg-badge', 'lg-badge--' + variant, className].filter(Boolean).join(' ')
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Button({
  variant = 'primary',
  size = 'md',
  href,
  className = '',
  children,
  ...rest
}) {
  const cls = ['lg-btn', 'lg-btn--' + variant, size !== 'md' ? 'lg-btn--' + size : '', className].filter(Boolean).join(' ');
  return href !== undefined ? /*#__PURE__*/React.createElement("a", _extends({
    href: href,
    className: cls
  }, rest), children) : /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Card({
  inverse,
  flat,
  className = '',
  children,
  ...rest
}) {
  const cls = ['lg-card', inverse ? 'lg-card--inverse' : '', flat ? 'lg-card--flat' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function IconButton({
  label,
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}) {
  const cls = ['lg-btn', 'lg-iconbtn', 'lg-btn--' + variant, size !== 'md' ? 'lg-btn--' + size : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-label": label,
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tag({
  dot,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['lg-tag', className].filter(Boolean).join(' ')
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    className: "lg-tag__dot"
  }), children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
function Dialog({
  open,
  title,
  actions,
  onClose,
  children
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "lg-overlay",
    onClick: e => {
      if (e.target === e.currentTarget && onClose) onClose();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lg-dialog",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title
  }, title && /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: '0 0 10px',
      fontSize: 'var(--size-h3)',
      fontWeight: 'var(--weight-black)',
      letterSpacing: 'var(--track-tight)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text-secondary)',
      fontSize: 15
    }
  }, children), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      justifyContent: 'flex-end',
      marginTop: 24
    }
  }, actions)));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Toast({
  alert,
  action,
  onAction,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['lg-toast', alert ? 'lg-toast--alert' : '', className].filter(Boolean).join(' '),
    role: "status"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "lg-toast__dot"
  }), /*#__PURE__*/React.createElement("span", null, children), action && /*#__PURE__*/React.createElement("button", {
    className: "lg-toast__action",
    onClick: onAction
  }, action));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tooltip({
  tip,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    "data-tip": tip,
    tabIndex: 0,
    className: className,
    style: {
      display: 'inline-block'
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Checkbox({
  label,
  className = '',
  ...rest
}) {
  const box = /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    className: "lg-check"
  }, rest));
  return label ? /*#__PURE__*/React.createElement("label", {
    className: ['lg-choice', className].filter(Boolean).join(' ')
  }, box, /*#__PURE__*/React.createElement("span", null, label)) : box;
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Input({
  label,
  hint,
  className = '',
  ...rest
}) {
  const field = /*#__PURE__*/React.createElement("input", _extends({
    className: "lg-input"
  }, rest));
  if (!label && !hint) return field;
  return /*#__PURE__*/React.createElement("label", {
    className: ['lg-field', className].filter(Boolean).join(' ')
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "lg-field__label"
  }, label), field, hint && /*#__PURE__*/React.createElement("span", {
    className: "lg-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Radio({
  label,
  className = '',
  ...rest
}) {
  const dot = /*#__PURE__*/React.createElement("input", _extends({
    type: "radio",
    className: "lg-radio"
  }, rest));
  return label ? /*#__PURE__*/React.createElement("label", {
    className: ['lg-choice', className].filter(Boolean).join(' ')
  }, dot, /*#__PURE__*/React.createElement("span", null, label)) : dot;
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Select({
  label,
  hint,
  className = '',
  children,
  ...rest
}) {
  const field = /*#__PURE__*/React.createElement("select", _extends({
    className: "lg-input"
  }, rest), children);
  if (!label && !hint) return field;
  return /*#__PURE__*/React.createElement("label", {
    className: ['lg-field', className].filter(Boolean).join(' ')
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "lg-field__label"
  }, label), field, hint && /*#__PURE__*/React.createElement("span", {
    className: "lg-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Switch({
  label,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ['lg-switch', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "lg-switch__track"
  }), label && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tabs({
  tabs,
  value,
  onChange,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['lg-tabs', className].filter(Boolean).join(' '),
    role: "tablist"
  }, rest), tabs.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    role: "tab",
    "aria-selected": value === t.id,
    className: "lg-tabs__tab",
    onClick: () => onChange && onChange(t.id)
  }, t.label)));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/SiteChrome.jsx
try { (() => {
const ASSETS = '../../assets/';
function Container({
  style,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container)',
      margin: '0 auto',
      padding: '0 32px',
      ...style
    }
  }, children);
}
function SectionHead({
  eyebrow,
  title,
  lede,
  ledeMax = 560
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      marginBottom: 40
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-eyebrow"
  }, eyebrow), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--size-display)',
      fontWeight: 'var(--weight-black)',
      letterSpacing: 'var(--track-display)',
      lineHeight: 'var(--leading-display)'
    }
  }, title), lede && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--size-body-lg)',
      color: 'var(--text-secondary)',
      maxWidth: ledeMax
    }
  }, lede));
}
function SiteNav() {
  const link = {
    fontSize: 14.5,
    fontWeight: 600,
    color: 'var(--text-body)',
    textDecoration: 'none',
    whiteSpace: 'nowrap'
  };
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 30,
      background: 'rgba(251,252,248,.88)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid var(--border-soft)'
    }
  }, /*#__PURE__*/React.createElement(Container, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 28,
      height: 68
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#top",
    style: {
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: ASSETS + 'crop-logo-lockup.png',
    alt: "Ligou",
    style: {
      height: 30,
      display: 'block'
    }
  })), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      gap: 24,
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#como",
    style: link
  }, "Como trabalha"), /*#__PURE__*/React.createElement("a", {
    href: "#demo",
    style: link
  }, "Veja em a\xE7\xE3o"), /*#__PURE__*/React.createElement("a", {
    href: "#preco",
    style: link
  }, "Pre\xE7o"), /*#__PURE__*/React.createElement("a", {
    href: "#faq",
    style: link
  }, "FAQ")), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    href: "#preco"
  }, "Quero ser Founding Partner")));
}
function SiteFooter() {
  const a = {
    color: 'var(--text-inverse-secondary)',
    textDecoration: 'none'
  };
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: 'var(--surface-inverse-deep)',
      color: 'var(--text-inverse)',
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(Container, {
    style: {
      padding: '56px 32px 40px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: ASSETS + 'crop-logo-mark.png',
    alt: "",
    style: {
      height: 34,
      borderRadius: '50%'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 800,
      fontSize: 24,
      letterSpacing: '-0.02em'
    }
  }, "Ligou")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '16px 0 0',
      maxWidth: 440,
      color: 'var(--text-inverse-secondary)',
      fontSize: 15
    }
  }, "Feito por um brasileiro nos EUA que cansou de ver conterr\xE2neo perdendo venda no telefone."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap',
      marginTop: 26,
      fontSize: 14,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "https://ligou.ai",
    style: a
  }, "ligou.ai"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .4
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("a", {
    href: "mailto:suporte@ligou.ai",
    style: a
  }, "suporte@ligou.ai"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .4
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: a
  }, "Termos"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .4
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: a
  }, "Privacidade")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 26,
      paddingTop: 18,
      borderTop: '1px solid rgba(251,252,248,.12)',
      fontSize: 12,
      color: 'rgba(251,252,248,.5)'
    }
  }, "Vers\xE3o local: chamada de demonstra\xE7\xE3o, reserva, Termos e Privacidade ainda n\xE3o conectados.")));
}
Object.assign(__ds_scope, { ASSETS, Container, SectionHead, SiteNav, SiteFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/SiteChrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/DemoSection.jsx
try { (() => {
function DemoSection() {
  const [tab, setTab] = React.useState('call');
  const row = {
    display: 'grid',
    gridTemplateColumns: '150px 1fr',
    gap: 14,
    padding: '13px 0',
    borderTop: '1px solid var(--border-soft)',
    fontSize: 15
  };
  const k = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 'var(--track-caps)',
    textTransform: 'uppercase',
    color: 'var(--text-eyebrow)',
    paddingTop: 2
  };
  return /*#__PURE__*/React.createElement("section", {
    id: "demo",
    style: {
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, null, /*#__PURE__*/React.createElement(__ds_scope.SectionHead, {
    eyebrow: "Exemplo do fluxo",
    title: "Veja o Ligou trabalhar.",
    lede: "Esta demonstra\xE7\xE3o ilustrativa separa o que o cliente disse, qual regra seria usada e o que ficaria registrado. Depois, a conversa continua diretamente com voc\xEA."
  }), /*#__PURE__*/React.createElement(__ds_scope.Tabs, {
    tabs: [{
      id: 'call',
      label: 'Ligação recebida'
    }, {
      id: 'chat',
      label: 'Conversa com o Ligou'
    }],
    value: tab,
    onChange: setTab
  }), /*#__PURE__*/React.createElement(__ds_scope.Card, {
    style: {
      marginTop: 18,
      padding: '28px 32px'
    }
  }, tab === 'call' ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "ink"
  }, "EN"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 'var(--track-caps)',
      textTransform: 'uppercase',
      color: 'var(--text-secondary)'
    }
  }, "Exemplo de chamada")), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: '12px 0 18px',
      fontSize: 'var(--size-h3)',
      fontWeight: 800,
      letterSpacing: 'var(--track-tight)'
    }
  }, "Pedido entendido. Pr\xF3ximo passo registrado."), /*#__PURE__*/React.createElement("div", {
    style: row
  }, /*#__PURE__*/React.createElement("span", {
    style: k
  }, "Resumo"), /*#__PURE__*/React.createElement("span", null, "Cliente em San Rafael pediu inspe\xE7\xE3o para entrada de \xE1gua pr\xF3xima \xE0 chamin\xE9.")), /*#__PURE__*/React.createElement("div", {
    style: row
  }, /*#__PURE__*/React.createElement("span", {
    style: k
  }, "Regra usada"), /*#__PURE__*/React.createElement("span", null, "Estimativa somente depois da inspe\xE7\xE3o.")), /*#__PURE__*/React.createElement("div", {
    style: row
  }, /*#__PURE__*/React.createElement("span", {
    style: k
  }, "A\xE7\xE3o no exemplo"), /*#__PURE__*/React.createElement("span", null, "Solicita\xE7\xE3o registrada para retorno hoje."))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      maxWidth: 560
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      alignSelf: 'flex-start',
      background: 'var(--surface-inverse-deep)',
      color: 'var(--text-inverse)',
      borderRadius: '16px 16px 16px 4px',
      padding: '12px 16px',
      fontSize: 15
    }
  }, "Posso oferecer o retorno amanh\xE3 de manh\xE3?"), /*#__PURE__*/React.createElement("div", {
    style: {
      alignSelf: 'flex-start',
      fontSize: 12,
      color: 'var(--text-muted)',
      marginTop: -6
    }
  }, "o Ligou \xB7 em portugu\xEAs"), /*#__PURE__*/React.createElement("div", {
    style: {
      alignSelf: 'flex-end',
      background: 'var(--lg-teal-100)',
      borderRadius: '16px 16px 4px 16px',
      padding: '12px 16px',
      fontSize: 15,
      fontWeight: 600
    }
  }, "Pode. Antes das 10h."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm"
  }, "Aprovar regra"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    variant: "secondary"
  }, "Ajustar"))))), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '16px 0 0',
      fontSize: 13.5,
      color: 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text-body)'
    }
  }, "Pr\xF3xima etapa"), " \u2014 Apps para iPhone e Android e liga\xE7\xF5es operacionais para clientes.")));
}
Object.assign(__ds_scope, { DemoSection });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/DemoSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/FaqSection.jsx
try { (() => {
const QA = [['Ele inventa preços?', 'Não. Ele usa apenas preços, faixas e condições aprovadas. Se a regra não existe, coleta o contexto e pede orientação.'], ['O que acontece quando não sabe?', 'Ele não improvisa. Explica que a equipe retorna, leva a pergunta até você em português e espera a decisão.'], ['Ele se identifica como assistente virtual?', 'Sim. O Ligou se apresenta com transparência como assistente virtual da sua empresa.'], ['Preciso falar inglês?', 'Não. Você configura, revisa e conversa com o Ligou em português. Ele atende o cliente em inglês ou português.'], ['Posso conversar diretamente com o Ligou?', 'Sim. No lançamento, pelo app web, por texto ou voz. iPhone e Android entram na próxima etapa.'], ['Como funciona o cancelamento?', 'O plano é mensal e sem fidelidade. Cancele antes da próxima renovação.']];
function FaqSection() {
  const [openIdx, setOpenIdx] = React.useState(0);
  return /*#__PURE__*/React.createElement("section", {
    id: "faq",
    style: {
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, null, /*#__PURE__*/React.createElement(__ds_scope.SectionHead, {
    eyebrow: "Perguntas diretas",
    title: "Antes de ligar.",
    lede: "O Ligou trabalha dentro do que voc\xEA autorizou e mant\xE9m voc\xEA no controle."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 720
    }
  }, QA.map(([q, a], i) => {
    const open = openIdx === i;
    return /*#__PURE__*/React.createElement("div", {
      key: q,
      style: {
        borderTop: '1px solid var(--border-soft)'
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenIdx(open ? -1 : i),
      "aria-expanded": open,
      style: {
        width: '100%',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        background: 'none',
        border: 'none',
        padding: '18px 2px',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left'
      }
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        fontSize: 17,
        letterSpacing: 'var(--track-tight)'
      }
    }, q), /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text-accent)',
        fontSize: 20,
        fontWeight: 700,
        transform: open ? 'rotate(45deg)' : 'none',
        transition: 'transform 240ms var(--ease-out)',
        flex: 'none'
      }
    }, "+")), open && /*#__PURE__*/React.createElement("p", {
      style: {
        margin: '0 0 18px',
        padding: '0 2px',
        fontSize: 15,
        color: 'var(--text-secondary)',
        maxWidth: 620
      }
    }, a));
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.WaveDivider, null), /*#__PURE__*/React.createElement(__ds_scope.Container, {
    style: {
      textAlign: 'center',
      paddingTop: 72
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.SectionHead, {
    eyebrow: "Demonstra\xE7\xE3o ilustrativa",
    title: "Veja o Ligou trabalhar.",
    lede: "Acompanhe a liga\xE7\xE3o de exemplo e veja o que o Ligou registra.",
    ledeMax: 999
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      justifyContent: 'center',
      marginTop: -14
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    href: "#demo"
  }, "Ver o Ligou trabalhar"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "secondary",
    href: "#demo"
  }, "Acompanhar o fluxo \u2197")))));
}
Object.assign(__ds_scope, { FaqSection });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/FaqSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/Hero.jsx
try { (() => {
function Hero() {
  return /*#__PURE__*/React.createElement("section", {
    id: "top",
    style: {
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.05fr .95fr',
      gap: 40,
      alignItems: 'end',
      paddingTop: 64
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 56
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Eyebrow, null, "Agente operacional bil\xEDngue"), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '18px 0 0',
      fontSize: 'var(--size-display-xl)',
      fontWeight: 'var(--weight-black)',
      lineHeight: 'var(--leading-display)',
      letterSpacing: 'var(--track-display)'
    }
  }, "Ligou?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-accent)'
    }
  }, "Atendido.")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '22px 0 0',
      fontSize: 'var(--size-body-lg)',
      fontWeight: 600,
      maxWidth: 460
    }
  }, "No lan\xE7amento, atende em ingl\xEAs, segue as regras do seu neg\xF3cio e te entrega o resumo em portugu\xEAs."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '12px 0 0',
      fontSize: 'var(--size-body)',
      color: 'var(--text-secondary)',
      maxWidth: 460
    }
  }, "Voc\xEA fala com o Ligou em portugu\xEAs. O Ligou fala com seus clientes \u2014 e mant\xE9m voc\xEA no controle."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      marginTop: 30,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    href: "#demo"
  }, "Ver o Ligou trabalhar"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "secondary",
    href: "#demo"
  }, "Acompanhar o fluxo \u2197")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      marginTop: 26,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "ink"
  }, "EN entra"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, "\u2192"), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "teal"
  }, "Suas regras operam"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, "\u2192"), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "outline"
  }, "PT volta"))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'flex',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: __ds_scope.ASSETS + 'crop-robot.png',
    alt: "Mascote do Ligou atendendo",
    style: {
      display: 'block',
      width: '100%',
      maxWidth: 400
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: -2,
      left: '50%',
      transform: 'translateX(-46%)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.CalloutCapsule, {
    label: "Ligou em cena",
    line: "Atende \xB7 opera \xB7 pede aprova\xE7\xE3o"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-soft)',
      background: 'var(--surface-sunken)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, {
    style: {
      display: 'grid',
      gridTemplateColumns: 'auto auto auto',
      justifyContent: 'space-between',
      gap: 24,
      padding: '26px 32px'
    }
  }, [['01', 'Atende em inglês', '“I need an estimate.”', 'Ele escuta o cliente e entende o pedido.'], ['02', 'Opera com contexto', 'Memória + agenda + ferramentas', 'Ele segue as regras aprovadas do seu negócio.'], ['03', 'Volta para você em português', '“Posso oferecer retorno amanhã?”', 'Quando falta uma decisão, ele pergunta antes de agir.']].map(([n, t, q, d]) => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      maxWidth: 300
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: n,
    label: t,
    active: n === '01',
    style: {
      whiteSpace: 'normal'
    }
  }), /*#__PURE__*/React.createElement("b", {
    style: {
      fontSize: 15,
      letterSpacing: 'var(--track-tight)'
    }
  }, q), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13.5,
      color: 'var(--text-secondary)'
    }
  }, d))))), /*#__PURE__*/React.createElement(__ds_scope.Container, {
    style: {
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap',
      padding: '26px 32px 0'
    }
  }, ['Limpeza', 'Pintura', 'Roofing', 'Landscaping', 'HVAC', 'Elétrica', 'Encanamento'].map((s, i) => /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    key: s,
    dot: i === 0
  }, s))));
}
Object.assign(__ds_scope, { Hero });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/HowSection.jsx
try { (() => {
function HowSection() {
  const h3 = {
    margin: '14px 0 8px',
    fontSize: 'var(--size-h3)',
    fontWeight: 800,
    letterSpacing: 'var(--track-tight)',
    lineHeight: 'var(--leading-tight)'
  };
  const p = {
    margin: 0,
    fontSize: 15,
    color: 'var(--text-secondary)'
  };
  return /*#__PURE__*/React.createElement("section", {
    id: "como",
    style: {
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, null, /*#__PURE__*/React.createElement(__ds_scope.SectionHead, {
    eyebrow: "Como ele trabalha",
    title: "Uma liga\xE7\xE3o. Tr\xEAs estados.",
    lede: "Antes de atender, o Ligou entrevista voc\xEA em portugu\xEAs. Servi\xE7os, prioridades, limites e exce\xE7\xF5es viram a mem\xF3ria operacional espec\xEDfica do seu neg\xF3cio. Depois, ele usa esse contexto em cada liga\xE7\xE3o."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 18
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Card, null, /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "01",
    label: "Atendendo",
    active: true
  }), /*#__PURE__*/React.createElement("h3", {
    style: h3
  }, "Seu cliente liga em ingl\xEAs."), /*#__PURE__*/React.createElement("p", {
    style: p
  }, "O Ligou escuta, entende o servi\xE7o e coleta o contexto sem fazer o cliente repetir tudo. Se o pedido exige avalia\xE7\xE3o, promete um pr\xF3ximo passo \u2014 n\xE3o um pre\xE7o inventado."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: __ds_scope.ASSETS + 'crop-robot-head.png',
    alt: "Ligou levando a m\xE3o ao headset enquanto atende",
    style: {
      height: 52,
      borderRadius: 12
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "ink"
  }, "EN"))), /*#__PURE__*/React.createElement(__ds_scope.Card, null, /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "02",
    label: "Operando"
  }), /*#__PURE__*/React.createElement("h3", {
    style: h3
  }, "Ele trabalha com as regras do seu neg\xF3cio."), /*#__PURE__*/React.createElement("p", {
    style: p
  }, "Consulta a mem\xF3ria daquela empresa, verifica a agenda e usa somente as ferramentas que voc\xEA autorizou. Se algo n\xE3o est\xE1 conectado ou permitido, n\xE3o finge que fez."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 18,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Tag, null, "Mem\xF3ria"), /*#__PURE__*/React.createElement(__ds_scope.Tag, null, "Agenda"), /*#__PURE__*/React.createElement(__ds_scope.Tag, null, "Ferramentas"), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "teal"
  }, "\u2713"))), /*#__PURE__*/React.createElement(__ds_scope.Card, null, /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "03",
    label: "Pedindo aprova\xE7\xE3o"
  }), /*#__PURE__*/React.createElement("h3", {
    style: h3
  }, "Quando falta uma decis\xE3o, ele pergunta."), /*#__PURE__*/React.createElement("p", {
    style: p
  }, "Leva a pergunta at\xE9 voc\xEA em portugu\xEAs, mostra o contexto, espera seu ok e s\xF3 ent\xE3o incorpora a regra aprovada. Nada aprendido em outro neg\xF3cio entra no seu."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 18,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-sunken)',
      border: '1px solid var(--border-soft)',
      borderRadius: '14px 14px 14px 4px',
      padding: '9px 13px',
      fontSize: 13.5,
      fontWeight: 600
    }
  }, "\u201CPosso oferecer o retorno amanh\xE3 de manh\xE3?\u201D"), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "orange"
  }, "?")))), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '26px 0 0',
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--text-body)'
    }
  }, "Ele melhora porque conhece melhor as suas regras \u2014 n\xE3o porque inventa as pr\xF3prias.")));
}
Object.assign(__ds_scope, { HowSection });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/HowSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/PricingSection.jsx
try { (() => {
function PricingSection() {
  const [open, setOpen] = React.useState(false);
  const li = {
    display: 'flex',
    gap: 9,
    fontSize: 14.5,
    alignItems: 'baseline'
  };
  const dot = /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--lg-teal-400)'
    }
  }, "\u2713");
  const tier = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    padding: '11px 0',
    borderTop: '1px solid rgba(251,252,248,.14)',
    fontSize: 14
  };
  return /*#__PURE__*/React.createElement("section", {
    id: "preco",
    style: {
      marginTop: 96
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Container, null, /*#__PURE__*/React.createElement(__ds_scope.SectionHead, {
    eyebrow: "Founding Partners",
    title: "Os primeiros ganham voz.",
    lede: "Os primeiros n\xE3o recebem s\xF3 uma condi\xE7\xE3o especial. Ganham voz para dizer onde o Ligou ajuda \u2014 e onde ainda atrapalha."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1.1fr',
      gap: 18,
      alignItems: 'stretch'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Card, {
    inverse: true,
    style: {
      padding: '32px 34px',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-inverse-secondary)'
    }
  }, "Pre\xE7o oficial ", /*#__PURE__*/React.createElement("s", null, "$499/m\xEAs")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 4,
      margin: '10px 0 4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 24,
      fontWeight: 700
    }
  }, "$"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: 64,
      fontWeight: 800,
      letterSpacing: '-0.03em',
      lineHeight: 1
    }
  }, "299"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 17,
      color: 'var(--text-inverse-secondary)'
    }
  }, "/m\xEAs")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--text-inverse-secondary)'
    }
  }, "Para os primeiros 25, enquanto a assinatura permanecer ativa."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      margin: '20px 0'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: li
  }, dot, /*#__PURE__*/React.createElement("span", null, "Ativa\xE7\xE3o de $499 gr\xE1tis para os 100 primeiros.")), /*#__PURE__*/React.createElement("span", {
    style: li
  }, dot, /*#__PURE__*/React.createElement("span", null, "$2.899 de vantagem no primeiro ano.")), /*#__PURE__*/React.createElement("span", {
    style: li
  }, dot, /*#__PURE__*/React.createElement("span", null, "Plano m\xEAs a m\xEAs. Sem fidelidade."))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: tier
  }, /*#__PURE__*/React.createElement("span", null, "Primeiros 25"), /*#__PURE__*/React.createElement("b", null, "$299 enquanto ativos")), /*#__PURE__*/React.createElement("div", {
    style: tier
  }, /*#__PURE__*/React.createElement("span", null, "Pr\xF3ximos 75"), /*#__PURE__*/React.createElement("b", null, "$299 por 12 meses; depois $499")), /*#__PURE__*/React.createElement("div", {
    style: tier
  }, /*#__PURE__*/React.createElement("span", null, "Depois dos 100"), /*#__PURE__*/React.createElement("b", null, "$499 por m\xEAs"))), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "accent",
    size: "lg",
    style: {
      marginTop: 22,
      alignSelf: 'flex-start'
    },
    onClick: () => setOpen(true)
  }, "Quero ser Founding Partner \u2192"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(true),
    style: {
      marginTop: 14,
      alignSelf: 'flex-start',
      background: 'none',
      border: 'none',
      padding: 0,
      font: 'inherit',
      fontSize: 13.5,
      color: 'var(--lg-teal-400)',
      textDecoration: 'underline',
      textUnderlineOffset: 3,
      cursor: 'pointer'
    }
  }, "Por que Founding Partners pagam menos?")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 18
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Card, {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      fontSize: 13,
      letterSpacing: 'var(--track-caps)',
      textTransform: 'uppercase',
      color: 'var(--text-eyebrow)'
    }
  }, "O que entra"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '14px 22px',
      marginTop: 16
    }
  }, [['Atendimento', 'Inglês e português, 24 horas.'], ['Configuração', 'Onboarding em português e regras aprovadas por você.'], ['Telefone', 'Número do Ligou ou redirecionamento do atual.'], ['Operação', 'Uma agenda, transferência e escalonamento.'], ['Controle', 'Resumos, histórico e consumo de minutos.'], ['Entrada no ar', 'Testes e sua aprovação final.']].map(([t, d]) => /*#__PURE__*/React.createElement("div", {
    key: t
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      fontSize: 14.5
    }
  }, t), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, d))))), /*#__PURE__*/React.createElement(__ds_scope.Card, {
    flat: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "outline"
  }, "400 minutos por m\xEAs"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13.5,
      color: 'var(--text-secondary)'
    }
  }, "Excedente a $0.35/min, somente com autoriza\xE7\xE3o pr\xE9via. Avisos autom\xE1ticos aos 70% e 90% do uso."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 22,
      padding: '4px 6px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "01",
    label: "Reserve",
    active: true
  }), /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "02",
    label: "Converse"
  }), /*#__PURE__*/React.createElement(__ds_scope.StepBadge, {
    n: "03",
    label: "Aprove e coloque no ar"
  })))), /*#__PURE__*/React.createElement(__ds_scope.Dialog, {
    open: open,
    title: "Reserva ainda n\xE3o conectada.",
    onClose: () => setOpen(false),
    actions: /*#__PURE__*/React.createElement(__ds_scope.Button, {
      size: "sm",
      onClick: () => setOpen(false)
    }, "Entendi")
  }, "Vers\xE3o local da p\xE1gina. Na vers\xE3o publicada, a reserva de Founding Partner e a conversa com a equipe acontecem aqui.")));
}
Object.assign(__ds_scope, { PricingSection });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/PricingSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/site/Landing.jsx
try { (() => {
function Landing() {
  return /*#__PURE__*/React.createElement("div", {
    "data-screen-label": "Landing ligou.ai"
  }, /*#__PURE__*/React.createElement(__ds_scope.SiteNav, null), /*#__PURE__*/React.createElement(__ds_scope.Hero, null), /*#__PURE__*/React.createElement(__ds_scope.HowSection, null), /*#__PURE__*/React.createElement(__ds_scope.DemoSection, null), /*#__PURE__*/React.createElement(__ds_scope.PricingSection, null), /*#__PURE__*/React.createElement(__ds_scope.FaqSection, null), /*#__PURE__*/React.createElement(__ds_scope.SiteFooter, null));
}
Object.assign(__ds_scope, { Landing });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/Landing.jsx", error: String((e && e.message) || e) }); }

__ds_ns.CalloutCapsule = __ds_scope.CalloutCapsule;

__ds_ns.Eyebrow = __ds_scope.Eyebrow;

__ds_ns.StepBadge = __ds_scope.StepBadge;

__ds_ns.WaveDivider = __ds_scope.WaveDivider;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.DemoSection = __ds_scope.DemoSection;

__ds_ns.FaqSection = __ds_scope.FaqSection;

__ds_ns.Hero = __ds_scope.Hero;

__ds_ns.HowSection = __ds_scope.HowSection;

__ds_ns.Landing = __ds_scope.Landing;

__ds_ns.PricingSection = __ds_scope.PricingSection;

__ds_ns.ASSETS = __ds_scope.ASSETS;

__ds_ns.Container = __ds_scope.Container;

__ds_ns.SectionHead = __ds_scope.SectionHead;

__ds_ns.SiteNav = __ds_scope.SiteNav;

__ds_ns.SiteFooter = __ds_scope.SiteFooter;

})();

// Starts checkout for Kinquest Family. The family is remembered on this device (no sign-up needed).
(function () {
  const get = () => { try { return localStorage.getItem('kq_familyId') || ''; } catch { return ''; } };
  const set = (id) => { try { localStorage.setItem('kq_familyId', id); } catch {} };
  window.kqCheckout = async function (plan, returnTo, familyId) {
    const res = await fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, familyId: familyId || get(), returnTo }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || 'Checkout is unavailable right now.');
    set(j.familyId);
    location.href = j.url;
  };
})();

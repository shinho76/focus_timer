window.addEventListener('securitypolicyviolation', (e) => {
  const p = document.getElementById('result');
  p.textContent = `CSP 위반 발생: ${e.violatedDirective} (${e.blockedURI})`;
  p.style.color = 'red';
});

window.setTimeout(() => {
  const ft = document.querySelector('focus-timer');
  const dial = ft.shadowRoot.querySelector('.ft-dial');
  const p = document.getElementById('result');
  if (dial && ft.shadowRoot.adoptedStyleSheets && ft.shadowRoot.adoptedStyleSheets.length > 0) {
    p.textContent = '통과: adoptedStyleSheets 경로로 정상 렌더됨 (위반 0건이면 성공)';
    p.style.color = 'green';
  } else if (dial) {
    p.textContent = '주의: <style> 폴백 경로 사용됨 — CSP 위반이 없었는지 위의 메시지를 확인할 것';
    p.style.color = 'orange';
  } else {
    p.textContent = '실패: 다이얼이 렌더되지 않음';
    p.style.color = 'red';
  }
}, 200);

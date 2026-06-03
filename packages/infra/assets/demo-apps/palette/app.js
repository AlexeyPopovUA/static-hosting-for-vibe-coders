const colors = ['#7c9cff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185'];

const swatches = document.getElementById('swatches');
const status = document.getElementById('status');

for (const color of colors) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch';
  button.style.backgroundColor = color;
  button.title = color;
  button.setAttribute('aria-label', `Copy ${color}`);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(color);
      status.textContent = `Copied ${color}`;
    } catch {
      status.textContent = color;
    }
  });
  swatches.appendChild(button);
}

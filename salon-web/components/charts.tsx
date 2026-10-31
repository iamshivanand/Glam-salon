'use client';
import { Chart as C, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend } from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
C.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend);

const gold = '#C9A86A', plum = '#2D1B2E', sage = '#7D8C7A';

export function RevenueChart({ labels, revenue }: { labels: string[]; revenue: number[] }) {
  return <Line data={{ labels, datasets: [{ label: 'Revenue ₹', data: revenue, borderColor: gold, backgroundColor: gold + '33', fill: true, tension: 0.4 }] }} options={{ plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } }} />;
}
export function CategoryDonut({ labels, values }: { labels: string[]; values: number[] }) {
  return <Doughnut data={{ labels, datasets: [{ data: values, backgroundColor: [gold, plum, sage, '#B76E79', '#8E7CC3', '#6FA8A0'] }] }} options={{ plugins: { legend: { position: 'bottom' } } }} />;
}
export function StaffBar({ labels, values, label = 'Bookings' }: { labels: string[]; values: number[]; label?: string }) {
  return <Bar data={{ labels, datasets: [{ label, data: values, backgroundColor: plum, borderRadius: 8 }] }} options={{ plugins: { legend: { display: false } } }} />;
}

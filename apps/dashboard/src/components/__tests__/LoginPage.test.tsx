// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from '../LoginPage';
function Entry() {
  const { state } = useLocation();
  return (
    <>
      <h1>Work email sign-in</h1>
      <output>{state?.from}</output>
    </>
  );
}
test('old login bookmarks reach the same email form and preserve the requested destination', () => {
  render(
    <MemoryRouter
      initialEntries={[{ pathname: '/login', state: { from: '/w/incidents/example' } }]}
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/sign-in" element={<Entry />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Work email sign-in' })).toBeTruthy();
  expect(screen.getByText('/w/incidents/example')).toBeTruthy();
  expect(document.querySelector('input[type=password]')).toBeNull();
});

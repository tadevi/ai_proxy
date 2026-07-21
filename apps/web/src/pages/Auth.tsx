import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
type Fields = { username: string; password: string };
export function Auth({ onSuccess }: { onSuccess: () => void }) {
  const [register, setRegister] = useState(false);
  const {
    register: r,
    handleSubmit,
    formState: { errors },
  } = useForm<Fields>();
  const mutation = useMutation({
    mutationFn: (data: Fields) =>
      api(`/api/auth/${register ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess,
  });
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form
        className="card w-full max-w-sm space-y-4"
        onSubmit={handleSubmit((d) => mutation.mutate(d))}
      >
        <div>
          <h1 className="text-xl font-semibold">
            {register ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="muted mt-1">Manage your private Anthropic gateway.</p>
        </div>
        <label className="block">
          <span className="label">Username</span>
          <input
            className="input"
            autoComplete="username"
            {...r('username', { required: true, minLength: 3 })}
          />
          {errors.username && <small className="text-red-400">At least 3 characters</small>}
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            {...r('password', { required: true, minLength: 6 })}
          />
          {errors.password && <small className="text-red-400">At least 6 characters</small>}
        </label>
        {mutation.error && <p className="text-sm text-red-400">{mutation.error.message}</p>}
        <button className="btn btn-primary w-full">{register ? 'Register' : 'Log in'}</button>
        <button
          type="button"
          className="w-full text-sm text-zinc-400 hover:text-white"
          onClick={() => setRegister(!register)}
        >
          {register ? 'Already registered? Log in' : 'Need an account? Register'}
        </button>
      </form>
    </div>
  );
}

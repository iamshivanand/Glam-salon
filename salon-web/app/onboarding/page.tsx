'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  setActiveSalonId,
  uploadFile,
  useCreateSalon,
  usePartnerSalon,
  usePatchSalon,
  useSubmitKyc,
  useSubmitSalon,
  useUploadStatus,
} from '@/lib/api';
import { useAuth, useAuthModal, isOwner } from '@/lib/store';

const SALON_TYPES = ['UNISEX', 'WOMEN_ONLY', 'MEN_ONLY', 'HOME_SERVICE'] as const;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export default function OnboardingPage() {
  const { user, hydrated } = useAuth();
  const { openModal } = useAuthModal();
  const [salonId, setSalonId] = useState<string | undefined>();
  const salon = usePartnerSalon(!!user && isOwner(user) && !salonId);
  const createSalon = useCreateSalon();
  const patchSalon = usePatchSalon();
  const submitSalon = useSubmitSalon();
  const submitKyc = useSubmitKyc();
  const uploadStatus = useUploadStatus();

  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    salon_type: 'UNISEX' as (typeof SALON_TYPES)[number],
    address_line: '',
    locality: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    postal_code: '',
    lat: 12.9719,
    lng: 77.6412,
  });
  const [kycForm, setKycForm] = useState({
    pan_number: '',
    gstin: '',
    bank_account_number: '',
    bank_ifsc: '',
    shop_license_s3_key: '',
    shop_license_name: '',
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!hydrated) return <div className="card p-8 mt-8">Checking your session…</div>;
  if (!user) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">Salon onboarding</h1>
        <p className="opacity-70 mt-2">Sign in with your salon owner phone number to create or verify a salon.</p>
        <button onClick={() => openModal('Sign in with your salon owner account.')} className="btn-primary mt-5">
          Sign in as salon owner
        </button>
      </div>
    );
  }
  if (!isOwner(user)) {
    return (
      <div className="card p-10 mt-8 max-w-xl mx-auto text-center">
        <h1 className="font-display text-3xl">This page is for salon owners</h1>
        <p className="opacity-70 mt-2">You are signed in as a customer.</p>
        <Link href="/account" className="chip !py-2 inline-block mt-4">Go to my account</Link>
      </div>
    );
  }

  const mustCreate = salon.isError;

  const create = async () => {
    setNotice(null);
    setProblem(null);
    try {
      const created: any = await createSalon.mutateAsync(createForm);
      setActiveSalonId(created.id);
      setSalonId(undefined);
      await salon.refetch();
      setNotice('Salon created. Add KYC details next.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const saveDetails = async () => {
    setNotice(null);
    setProblem(null);
    try {
      await patchSalon.mutateAsync({
        name: createForm.name || salon.data?.name,
        description: createForm.description || salon.data?.description,
        address_line: createForm.address_line || salon.data?.address_line,
        locality: createForm.locality || salon.data?.locality,
        city: createForm.city || salon.data?.city,
        state: createForm.state,
        postal_code: createForm.postal_code || salon.data?.postal_code,
      });
      setNotice('Salon details saved.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const uploadLicense = async (file: File) => {
    setNotice(null);
    setProblem(null);
    try {
      const uploaded = await uploadFile(file, 'kyc_document', salon.data?.id);
      setKycForm({ ...kycForm, shop_license_s3_key: uploaded.key, shop_license_name: file.name });
      setNotice('Licence uploaded and verified. Submit KYC to finish.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const saveKyc = async () => {
    setNotice(null);
    setProblem(null);
    const pan = kycForm.pan_number.replace(/\s+/g, '').toUpperCase();
    const gstin = kycForm.gstin.replace(/\s+/g, '').toUpperCase();
    const ifsc = kycForm.bank_ifsc.replace(/\s+/g, '').toUpperCase();
    const account = kycForm.bank_account_number.replace(/\s+/g, '');

    if (!PAN_RE.test(pan)) return setProblem('PAN must look like ABCDE1234F.');
    if (gstin && !GSTIN_RE.test(gstin)) return setProblem('GSTIN must be a 15-character GST number.');
    if (!/^\d{6,20}$/.test(account)) return setProblem('Bank account number must be 6-20 digits.');
    if (!IFSC_RE.test(ifsc)) return setProblem('IFSC must look like HDFC0001234.');

    try {
      await submitKyc.mutateAsync({
        pan_number: pan,
        gstin: gstin || undefined,
        bank_account_number: account,
        bank_ifsc: ifsc,
        shop_license_s3_key: kycForm.shop_license_s3_key || undefined,
      });
      setNotice('KYC submitted. Our team reviews it before the salon goes live.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  const submit = async () => {
    setNotice(null);
    setProblem(null);
    try {
      await submitSalon.mutateAsync();
      setNotice('Salon submitted for review.');
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className="pt-8 max-w-3xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-accent">Partner onboarding</p>
          <h1 className="font-display text-4xl mt-1">Get your salon verified</h1>
          <p className="text-sm opacity-60 mt-1">Create the salon, upload licence and bank details, then submit for review.</p>
        </div>
        <Link href="/admin" className="chip !py-2">Back to console</Link>
      </div>

      {notice && <div className="rounded-xl border border-green-300 bg-green-50 text-green-800 text-sm px-4 py-2">{notice}</div>}
      {problem && <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-2">{problem}</div>}

      {salon.data && (
        <div className="card p-5 flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <p className="font-semibold">{salon.data.name}</p>
            <p className="text-xs opacity-60">{salon.data.locality}, {salon.data.city}</p>
          </div>
          <span className="chip !py-1 !px-3">Salon: {salon.data.verification_status}</span>
          <span className="chip !py-1 !px-3">KYC: {salon.data.kyc?.status ?? 'not submitted'}</span>
          {salon.data.kyc?.rejection_reason && (
            <span className="text-xs text-red-700 w-full">Rejected: {salon.data.kyc.rejection_reason}</span>
          )}
        </div>
      )}

      {(mustCreate || salonId) && (
        <section className="card p-6 space-y-3">
          <h2 className="font-semibold">{salonId ? 'Salon created' : '1 · Create your salon'}</h2>
          {salonId ? (
            <p className="text-sm opacity-70">Your salon exists. Continue below to add KYC details.</p>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="text-xs opacity-60">Salon name
                  <input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
                <label className="text-xs opacity-60">Type
                  <select value={createForm.salon_type} onChange={(e) => setCreateForm({ ...createForm, salon_type: e.target.value as (typeof SALON_TYPES)[number] })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm">
                    {SALON_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                  </select>
                </label>
                <label className="text-xs opacity-60 sm:col-span-2">Address
                  <input value={createForm.address_line} onChange={(e) => setCreateForm({ ...createForm, address_line: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
                <label className="text-xs opacity-60">Locality
                  <input value={createForm.locality} onChange={(e) => setCreateForm({ ...createForm, locality: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
                <label className="text-xs opacity-60">City
                  <input value={createForm.city} onChange={(e) => setCreateForm({ ...createForm, city: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
                <label className="text-xs opacity-60">State
                  <input value={createForm.state} onChange={(e) => setCreateForm({ ...createForm, state: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
                <label className="text-xs opacity-60">PIN code
                  <input value={createForm.postal_code} onChange={(e) => setCreateForm({ ...createForm, postal_code: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
                </label>
              </div>
              <button onClick={create} disabled={createSalon.isPending} className="btn-primary !py-2 !px-4 text-sm">
                {createSalon.isPending ? 'Creating…' : 'Create salon'}
              </button>
            </>
          )}
        </section>
      )}

      {salon.data && (
        <section className="card p-6 space-y-3">
          <h2 className="font-semibold">2 · Store details</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-xs opacity-60">Name
              <input defaultValue={salon.data.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
            <label className="text-xs opacity-60">Locality
              <input defaultValue={salon.data.locality} onChange={(e) => setCreateForm({ ...createForm, locality: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
            <label className="text-xs opacity-60 sm:col-span-2">Address
              <input defaultValue={salon.data.address_line} onChange={(e) => setCreateForm({ ...createForm, address_line: e.target.value })} className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
          </div>
          <button onClick={saveDetails} disabled={patchSalon.isPending} className="chip !py-2">Save details</button>
        </section>
      )}

      {salon.data && (
        <section className="card p-6 space-y-3">
          <h2 className="font-semibold">3 · KYC & payout details</h2>
          <p className="text-xs opacity-60">PAN and bank account are encrypted at rest. We never return them in responses.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-xs opacity-60">PAN
              <input value={kycForm.pan_number} onChange={(e) => setKycForm({ ...kycForm, pan_number: e.target.value.toUpperCase() })} maxLength={10} placeholder="ABCDE1234F" className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
            <label className="text-xs opacity-60">GSTIN (optional)
              <input value={kycForm.gstin} onChange={(e) => setKycForm({ ...kycForm, gstin: e.target.value.toUpperCase() })} maxLength={15} placeholder="29ABCDE1234F1Z5" className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
            <label className="text-xs opacity-60">Bank account
              <input value={kycForm.bank_account_number} onChange={(e) => setKycForm({ ...kycForm, bank_account_number: e.target.value })} maxLength={20} inputMode="numeric" placeholder="6-20 digits" className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
            <label className="text-xs opacity-60">IFSC
              <input value={kycForm.bank_ifsc} onChange={(e) => setKycForm({ ...kycForm, bank_ifsc: e.target.value.toUpperCase() })} maxLength={11} placeholder="HDFC0001234" className="mt-1 w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="chip !py-2 cursor-pointer">
              Upload shop licence
              <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => e.target.files?.[0] && uploadLicense(e.target.files[0])} />
            </label>
            <span className="text-[11px] opacity-50">
              {kycForm.shop_license_name ||
                (kycForm.shop_license_s3_key || salon.data.kyc?.shop_license_s3_key
                  ? 'Licence on file'
                  : 'PDF or image, up to 10 MB')}
            </span>
            <span className="text-[11px] opacity-50">
              Storage: {uploadStatus.data?.configured ? uploadStatus.data.provider : 'not configured'}
            </span>
          </div>
          {!uploadStatus.data?.configured && (
            <p className="text-[11px] opacity-50">Licence uploads require S3 configuration; KYC can still be submitted without a file.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button onClick={saveKyc} disabled={submitKyc.isPending} className="btn-primary !py-2 !px-4 text-sm">
              {submitKyc.isPending ? 'Submitting…' : 'Submit KYC'}
            </button>
            <button onClick={submit} disabled={submitSalon.isPending} className="chip !py-2">
              Submit salon for review
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

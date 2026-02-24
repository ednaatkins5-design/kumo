export function detectCountryFromPhone(phone: string): string | null {
    if (!phone) return null;
    if (phone.startsWith('+254')) return 'KE';
    if (phone.startsWith('+255')) return 'TZ';
    if (phone.startsWith('+256')) return 'UG';
    if (phone.startsWith('+1')) return 'US';
    return null;
}

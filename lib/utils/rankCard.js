import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

try {
    GlobalFonts.loadSystemFonts();
} catch {}

const FONT_STACK = '"DejaVu Sans", sans-serif';

/**
 * Generate a PNG buffer for a user's rank card
 * @param {import('discord.js').User} user 
 * @param {{ xp: number, level: number }} data 
 * @param {number} neededXP 
 * @returns {Promise<Buffer>}
 */
export async function generateRankCard(user, data, neededXP) {
    const width = 800;
    const height = 240;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Background
    ctx.fillStyle = '#1e1f22';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
    ctx.fill();

    // Subtle inner gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, 'rgba(88, 101, 242, 0.12)');
    gradient.addColorStop(1, 'rgba(30, 31, 34, 0.6)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
    ctx.fill();

    // Card border
    ctx.strokeStyle = '#383a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, width - 2, height - 2, 16);
    ctx.stroke();

    // 2. Avatar (Left Side)
    const avatarX = 40;
    const avatarY = 40;
    const avatarSize = 160;
    const avatarRadius = avatarSize / 2;

    const avatarUrl = typeof user?.displayAvatarURL === 'function'
        ? user.displayAvatarURL({ extension: 'png', size: 256 })
        : null;

    let avatarLoaded = false;
    if (avatarUrl) {
        try {
            const avatarImage = await loadImage(avatarUrl);
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatarImage, avatarX, avatarY, avatarSize, avatarSize);
            ctx.restore();
            avatarLoaded = true;
        } catch {
            avatarLoaded = false;
        }
    }

    if (!avatarLoaded) {
        // Fallback stylized initial avatar
        ctx.fillStyle = '#5865F2';
        ctx.beginPath();
        ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold 72px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initial = (user?.username || 'U').charAt(0).toUpperCase();
        ctx.fillText(initial, avatarX + avatarRadius, avatarY + avatarRadius);
    }

    // Avatar ring
    ctx.strokeStyle = '#5865F2';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
    ctx.stroke();

    // 3. User Info & Stats (Middle / Right)
    const textStartX = 230;

    // Username
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f3f5';
    ctx.font = `bold 32px ${FONT_STACK}`;
    const username = user?.username || 'Unknown User';
    const truncatedName = username.length > 18 ? username.slice(0, 17) + '…' : username;
    ctx.fillText(truncatedName, textStartX, 80);

    // Level Badge (Top Right)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#949ba4';
    ctx.font = `bold 18px ${FONT_STACK}`;
    ctx.fillText('LEVEL', width - 85, 78);

    ctx.fillStyle = '#5865F2';
    ctx.font = `bold 36px ${FONT_STACK}`;
    ctx.fillText(String(data.level), width - 40, 78);

    // XP Numbers & Percentage
    const currentXP = Math.max(0, data.xp || 0);
    const targetXP = Math.max(1, neededXP || 100);
    const progressPercent = Math.min(100, Math.floor((currentXP / targetXP) * 100));

    ctx.textAlign = 'left';
    ctx.fillStyle = '#dbdee1';
    ctx.font = `bold 20px ${FONT_STACK}`;
    ctx.fillText(`${currentXP.toLocaleString()} / ${targetXP.toLocaleString()} XP`, textStartX, 135);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#949ba4';
    ctx.font = `bold 20px ${FONT_STACK}`;
    ctx.fillText(`${progressPercent}%`, width - 40, 135);

    // 4. Progress Bar
    const barX = textStartX;
    const barY = 155;
    const barWidth = width - textStartX - 40;
    const barHeight = 28;
    const barRadius = 14;

    // Background track
    ctx.fillStyle = '#2b2d31';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barWidth, barHeight, barRadius);
    ctx.fill();

    ctx.strokeStyle = '#383a40';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fill track
    const fillWidth = Math.max(barRadius * 2, Math.floor(barWidth * (progressPercent / 100)));
    if (fillWidth > 0) {
        const barGradient = ctx.createLinearGradient(barX, barY, barX + fillWidth, barY);
        barGradient.addColorStop(0, '#5865F2');
        barGradient.addColorStop(1, '#7983F5');
        ctx.fillStyle = barGradient;

        ctx.beginPath();
        ctx.roundRect(barX, barY, fillWidth, barHeight, barRadius);
        ctx.fill();
    }

    return canvas.toBuffer('image/png');
}

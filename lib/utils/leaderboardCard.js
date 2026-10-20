import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

try {
    GlobalFonts.loadSystemFonts();
} catch {}

const FONT_STACK = '"DejaVu Sans", sans-serif';

/**
 * Generate a PNG buffer for the guild leaderboard
 * @param {import('discord.js').Guild} guild 
 * @param {Array<{ rank: number, user: { username: string, displayAvatarURL?: Function }, xp: number, level: number }>} players 
 * @returns {Promise<Buffer>}
 */
export async function generateLeaderboardCard(guild, players = []) {
    const width = 850;
    const rowHeight = 60;
    const headerHeight = 110;
    const paddingBottom = 25;
    const totalRows = Math.max(1, players.length);
    const height = headerHeight + (totalRows * rowHeight) + paddingBottom;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Background
    ctx.fillStyle = '#1e1f22';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
    ctx.fill();

    // Subtle header gradient
    const gradient = ctx.createLinearGradient(0, 0, width, headerHeight);
    gradient.addColorStop(0, 'rgba(88, 101, 242, 0.22)');
    gradient.addColorStop(1, 'rgba(30, 31, 34, 0.0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, headerHeight, 16);
    ctx.fill();

    // Card border
    ctx.strokeStyle = '#383a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, width - 2, height - 2, 16);
    ctx.stroke();

    // 2. Header: {logo} {guild name} Leaderboard
    const logoX = 40;
    const logoY = 32;
    const logoSize = 48;
    const logoRadius = logoSize / 2;

    const guildIconUrl = typeof guild?.iconURL === 'function'
        ? guild.iconURL({ extension: 'png', size: 128 })
        : (typeof guild?.icon === 'string' && guild.id ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null);

    let logoLoaded = false;
    if (guildIconUrl) {
        try {
            const guildImg = await loadImage(guildIconUrl);
            ctx.save();
            ctx.beginPath();
            ctx.arc(logoX + logoRadius, logoY + logoRadius, logoRadius, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(guildImg, logoX, logoY, logoSize, logoSize);
            ctx.restore();
            logoLoaded = true;
        } catch {
            logoLoaded = false;
        }
    }

    if (!logoLoaded) {
        // Fallback stylized circular initial badge
        ctx.fillStyle = '#5865F2';
        ctx.beginPath();
        ctx.arc(logoX + logoRadius, logoY + logoRadius, logoRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold 20px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initial = (guild?.name || 'S').charAt(0).toUpperCase();
        ctx.fillText(initial, logoX + logoRadius, logoY + logoRadius);
    }

    // Logo accent ring
    ctx.strokeStyle = '#5865F2';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(logoX + logoRadius, logoY + logoRadius, logoRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Guild Title: {guild name} Leaderboard
    const textStartX = logoX + logoSize + 16;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f3f5';
    ctx.font = `bold 24px ${FONT_STACK}`;
    const guildTitle = (guild?.name || 'Server') + ' Leaderboard';
    const truncatedTitle = guildTitle.length > 30 ? guildTitle.slice(0, 29) + '…' : guildTitle;
    ctx.fillText(truncatedTitle, textStartX, 54);

    // Subtitle
    ctx.fillStyle = '#949ba4';
    ctx.font = `14px ${FONT_STACK}`;
    ctx.fillText(`Top ranked members by level and XP`, textStartX, 78);

    // 3. Player Rows
    const startY = headerHeight;
    const rowWidth = width - 80;

    for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const y = startY + (i * rowHeight);
        const cardH = 48;

        // Row background
        ctx.fillStyle = '#2b2d31';
        ctx.beginPath();
        ctx.roundRect(40, y, rowWidth, cardH, 8);
        ctx.fill();

        ctx.strokeStyle = '#383a40';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Rank Badge
        const rank = player.rank || (i + 1);
        const badgeX = 64;
        const badgeY = y + 24;
        const badgeRadius = 14;

        if (rank === 1) {
            ctx.fillStyle = '#FEE75C'; // Gold
        } else if (rank === 2) {
            ctx.fillStyle = '#C0C0C0'; // Silver
        } else if (rank === 3) {
            ctx.fillStyle = '#CD7F32'; // Bronze
        } else {
            ctx.fillStyle = '#3f4147';
        }

        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = rank <= 3 ? '#1e1f22' : '#dbdee1';
        ctx.font = `bold 13px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rank), badgeX, badgeY);

        // Avatar
        const avatarX = 95;
        const avatarY = y + 7;
        const avatarSize = 34;
        const avatarRadius = avatarSize / 2;

        const avatarUrl = typeof player.user?.displayAvatarURL === 'function'
            ? player.user.displayAvatarURL({ extension: 'png', size: 128 })
            : null;

        let avatarLoaded = false;
        if (avatarUrl) {
            try {
                const img = await loadImage(avatarUrl);
                ctx.save();
                ctx.beginPath();
                ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
                ctx.restore();
                avatarLoaded = true;
            } catch {
                avatarLoaded = false;
            }
        }

        if (!avatarLoaded) {
            ctx.fillStyle = '#5865F2';
            ctx.beginPath();
            ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#FFFFFF';
            ctx.font = `bold 16px ${FONT_STACK}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const initial = (player.user?.username || 'U').charAt(0).toUpperCase();
            ctx.fillText(initial, avatarX + avatarRadius, avatarY + avatarRadius);
        }

        // Username
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2f3f5';
        ctx.font = `bold 16px ${FONT_STACK}`;
        const name = player.user?.username || `User ${player.userId || (i + 1)}`;
        const truncatedName = name.length > 20 ? name.slice(0, 19) + '…' : name;
        ctx.fillText(truncatedName, 145, y + 24);

        // Level Pill
        const levelText = `Level ${player.level || 1}`;
        const pillX = 490;
        const pillY = y + 12;
        const pillW = 85;
        const pillH = 24;

        ctx.fillStyle = 'rgba(88, 101, 242, 0.25)';
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 6);
        ctx.fill();

        ctx.strokeStyle = '#5865F2';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#5865F2';
        ctx.font = `bold 12px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(levelText, pillX + (pillW / 2), pillY + (pillH / 2));

        // XP Text
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#dbdee1';
        ctx.font = `bold 15px ${FONT_STACK}`;
        const xpFormatted = (player.xp || 0).toLocaleString() + ' XP';
        ctx.fillText(xpFormatted, width - 60, y + 24);
    }

    return canvas.toBuffer('image/png');
}

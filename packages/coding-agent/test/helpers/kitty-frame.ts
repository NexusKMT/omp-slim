/** 1×1 red PNG, small enough to fit one Kitty chunk. */
export const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Single-chunk Kitty direct-PNG transmission, as terminal programs emit it. */
export function kittyPngFrame(pngBase64: string): string {
	return `\x1b_Ga=T,t=d,f=100,q=2,m=0;${pngBase64}\x1b\\`;
}

import { Star } from 'lucide-react'

type Props = {
  value: number
  label: string
  disabled?: boolean
  onChange: (rating: number) => void
}

/** 0–5 星。再点当前星级 = 清除评分。 */
export default function RatingStars({ value, label, disabled = false, onChange }: Props) {
  return (
    <div className="rating-stars" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map(rating => {
        const on = value >= rating
        return (
          <button
            key={rating}
            type="button"
            className={on ? 'on' : ''}
            aria-label={`${label} ${rating} 星`}
            aria-pressed={on}
            title={on && value === rating ? '再点一下清除评分' : `${rating} 星`}
            disabled={disabled}
            onClick={() => onChange(value === rating ? 0 : rating)}
          >
            <Star
              size={12}
              strokeWidth={1.5}
              fill={on ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
        )
      })}
    </div>
  )
}
